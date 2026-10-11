import Foundation
import AVFoundation

struct Piece: Decodable { let text: String; let lang: String; let voice: String? }
struct Request: Decodable { let pieces: [Piece]; let rate: Float; let pitch: Float; let volume: Float; let pause: Double; let timing: Bool? }
struct Word: Codable { let index: Int; let length: Int; let time: Double }
struct Segment: Codable { let index: Int; let start: Double; let duration: Double; let voice: String; let words: [Word]; let timing: String }
struct Result: Codable { let duration: Double; let segments: [Segment] }

func emit(_ value: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: value) { print(String(decoding:d,as:UTF8.self)); fflush(stdout) } }
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }

// Match Chromium's Web Speech -> AVSpeech mapping used by Electron preview.
// https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/speech/tts_mac.mm
// Above 1, multiplying the default directly makes exported speech too fast.
func nativeSpeechRate(_ webRate: Float) -> Float {
    let rate: Float
    if webRate < 1 {
        rate = webRate * AVSpeechUtteranceDefaultSpeechRate
    } else {
        let proportion = min(webRate - 1, 3) / 3
        rate = AVSpeechUtteranceDefaultSpeechRate + proportion *
            (AVSpeechUtteranceMaximumSpeechRate - AVSpeechUtteranceDefaultSpeechRate)
    }
    return min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, rate))
}

final class Writer: NSObject, AVSpeechSynthesizerDelegate {
    let request: Request, directory: URL
    let synth = AVSpeechSynthesizer()
    var index = 0, segments: [Segment] = [], file: AVAudioFile?, format: AVAudioFormat?
    var frames: Int64 = 0, markers: [(Int, Int, Int)] = [], error: String?, ending=false
    let lock = NSLock()
    var timingStart: Double=0, timedWords: [Word]=[], phase="writing", audioDuration: Double=0, selectedVoice=""
    var timingUtterance: AVSpeechUtterance?
    init(_ request: Request, _ directory: URL) { self.request=request; self.directory=directory; super.init(); synth.delegate=self }
    func utterance(_ voice:AVSpeechSynthesisVoice) -> AVSpeechUtterance {
        let u=AVSpeechUtterance(string:request.pieces[index].text); u.voice=voice
        u.rate=nativeSpeechRate(request.rate)
        u.pitchMultiplier=request.pitch; u.volume=request.volume; return u
    }
    func speechSynthesizer(_ synthesizer:AVSpeechSynthesizer,didStart utterance:AVSpeechUtterance) {
        if utterance === timingUtterance { timingStart=ProcessInfo.processInfo.systemUptime }
    }
    func speechSynthesizer(_ synthesizer:AVSpeechSynthesizer,willSpeakRangeOfSpeechString range:NSRange,utterance:AVSpeechUtterance) {
        if utterance === timingUtterance { timedWords.append(Word(index:range.location,length:range.length,time:max(0,ProcessInfo.processInfo.systemUptime-timingStart))) }
    }
    func speechSynthesizer(_ synthesizer:AVSpeechSynthesizer,didFinish utterance:AVSpeechUtterance) {
        guard phase=="timing", utterance === timingUtterance else { return }
        timingUtterance=nil
        let elapsed=ProcessInfo.processInfo.systemUptime-timingStart
        // These are observed system word events, not guessed word-length timings.
        // File synthesis and real-time callbacks can have different startup/tail delays.
        let words=timedWords.map { Word(index:$0.index,length:$0.length,time:min(audioDuration,max(0,$0.time * audioDuration/max(0.001,elapsed)))) }
        complete(words,"system-playback-aligned")
    }
    func complete(_ words:[Word],_ timing:String) {
        segments.append(Segment(index:index,start:0,duration:audioDuration,voice:selectedVoice,words:words,timing:timing))
        emit(["progress":index+1,"total":request.pieces.count,"markers":words.count,"timing":timing])
        phase="writing"; index+=1; DispatchQueue.main.asyncAfter(deadline:.now()+0.1) { self.next() }
    }
    func next() {
        if index >= request.pieces.count {
            do {
                // afconvert normalizes voice-dependent sample formats using built-in macOS tools.
                let target = AVAudioFormat(commonFormat:.pcmFormatFloat32, sampleRate:24000, channels:1, interleaved:false)!
                let settings: [String:Any] = [AVFormatIDKey:kAudioFormatLinearPCM, AVSampleRateKey:24000, AVNumberOfChannelsKey:1, AVLinearPCMBitDepthKey:16, AVLinearPCMIsFloatKey:false, AVLinearPCMIsBigEndianKey:false]
                var joined: AVAudioFile? = try AVAudioFile(forWriting:directory.appendingPathComponent("audio.wav"), settings:settings, commonFormat:.pcmFormatFloat32, interleaved:false)
                var starts: Double = 0, normalized: [Segment] = []
                for (n, seg) in segments.enumerated() {
                    let source = directory.appendingPathComponent("piece-\(n).wav")
                    let converted = directory.appendingPathComponent("normalized-\(n).wav")
                    let process = Process(); process.executableURL=URL(fileURLWithPath:"/usr/bin/afconvert")
                    process.arguments=["-f","WAVE","-d","LEI16@24000","-c","1",source.path,converted.path]
                    try process.run(); process.waitUntilExit(); if process.terminationStatus != 0 { throw NSError(domain:"afconvert",code:1) }
                    let input = try AVAudioFile(forReading:converted, commonFormat:.pcmFormatFloat32, interleaved:false)
                    let duration = Double(input.length)/24000
                    normalized.append(Segment(index:n,start:starts,duration:duration,voice:seg.voice,words:seg.words,timing:seg.timing))
                    let buffer=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:8192)!
                    while input.framePosition < input.length { try input.read(into:buffer); try joined!.write(from:buffer) }
                    starts += duration
                    if n < segments.count-1 {
                        var left=Int(request.pause * 24000 / 1000)
                        while left > 0 { let count=min(left,8192); buffer.frameLength=AVAudioFrameCount(count); memset(buffer.floatChannelData![0],0,count*4); try joined!.write(from:buffer); left-=count }
                        starts += request.pause/1000
                    }
                }
                // Finalize RIFF/data sizes before another process reads the WAV.
                joined=nil
                let result = Result(duration:starts,segments:normalized)
                try JSONEncoder().encode(result).write(to:directory.appendingPathComponent("timeline.json"))
                emit(["done":true,"duration":starts]); exit(0)
            } catch { fail("Не удалось собрать WAV: \(error)") }
        }
        let piece=request.pieces[index]
        let requestedVoice = piece.voice != nil ? AVSpeechSynthesisVoice(identifier:piece.voice!) : AVSpeechSynthesisVoice(language:piece.lang)
        guard let voice = requestedVoice else { fail("Выбранный системный голос недоступен для сохранения: \(piece.voice ?? piece.lang)") }
        frames=0; markers=[]; file=nil; format=nil; ending=false
        let sessionIndex=index
        synth.write(utterance(voice), toBufferCallback: { buffer in
            self.lock.lock(); defer { self.lock.unlock() }
            guard let pcm=buffer as? AVAudioPCMBuffer else { return }
            if self.ending || self.index != sessionIndex { return }
            if pcm.frameLength == 0 {
                self.ending=true
                self.file=nil
                DispatchQueue.main.async { self.finish(voice.identifier) }
                return
            }
            do {
                if self.file == nil {
                    self.format=pcm.format
                    self.file=try AVAudioFile(forWriting:self.directory.appendingPathComponent("piece-\(self.index).wav"),settings:pcm.format.settings,commonFormat:pcm.format.commonFormat,interleaved:pcm.format.isInterleaved)
                }
                try self.file!.write(from:pcm); self.frames += Int64(pcm.frameLength)
            } catch { self.error="\(error)" }
        }, toMarkerCallback: { values in
            self.lock.lock(); defer { self.lock.unlock() }
            guard self.index==sessionIndex && !self.ending else { return }
            for marker in values where marker.mark == .word { self.markers.append((marker.textRange.location,marker.textRange.length,marker.byteSampleOffset)) }
        })
    }
    func finish(_ voice: String) {
        lock.lock(); defer { lock.unlock() }
        if let error=error { fail(error) }
        guard let format=format, frames>0 else { fail("Голос не вернул аудио. Попробуйте другой локальный голос.") }
        let bytes=Double(format.streamDescription.pointee.mBytesPerFrame)
        let words=markers.map { Word(index:$0.0,length:$0.1,time:Double($0.2)/bytes/format.sampleRate) }.sorted { $0.time < $1.time }
        audioDuration=Double(frames)/format.sampleRate; selectedVoice=voice
        if request.timing == false { DispatchQueue.main.async { self.complete([],"not-requested") } }
        else if !words.isEmpty { DispatchQueue.main.async { self.complete(words,"audio-markers") } }
        else {
            phase="timing"; timedWords=[]
            DispatchQueue.main.asyncAfter(deadline:.now()+0.1) {
                guard let v=AVSpeechSynthesisVoice(identifier:voice) else { fail("Selected voice unavailable") }
                let u=self.utterance(v); u.volume=0; self.timingUtterance=u; self.synth.speak(u)
            }
        }
    }
}

// Diagnostic only: verify the actual compiled mapping without synthesizing speech.
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--rate-map" {
    let rows = [Float(0.5), 0.8, 1, 1.5, 2, 4].map { ["web": $0, "native": nativeSpeechRate($0)] }
    let data = try JSONSerialization.data(withJSONObject: rows)
    print(String(decoding: data, as: UTF8.self)); exit(0)
}
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--voices" {
    let voices=AVSpeechSynthesisVoice.speechVoices().map { ["id":$0.identifier,"name":$0.name,"lang":$0.language] }
    let data=try JSONSerialization.data(withJSONObject:voices); print(String(decoding:data,as:UTF8.self)); exit(0)
}
guard CommandLine.arguments.count == 3 else { fail("Usage: speech-export request.json output-directory") }
do {
    let request=try JSONDecoder().decode(Request.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))
    let directory=URL(fileURLWithPath:CommandLine.arguments[2]); try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    let writer=Writer(request,directory); writer.next()
    RunLoop.main.run()
} catch { fail("\(error)") }
