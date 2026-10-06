import Foundation
import AVFoundation
import CoreGraphics
import ImageIO

struct Frame: Decodable { let file: String; let time: Double }
struct Manifest: Decodable { let audio: String; let output: String; let width: Int; let height: Int; let fps: Int; let duration: Double; let frames: [Frame] }
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }
guard CommandLine.arguments.count == 2 else { fail("Usage: video-export manifest.json") }
do {
    let url=URL(fileURLWithPath:CommandLine.arguments[1]), directory=url.deletingLastPathComponent()
    let m=try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:url))
    guard m.width==960, m.height==240, m.fps==24, m.duration>0, !m.frames.isEmpty else { fail("Invalid video manifest") }
    let writer=try AVAssetWriter(outputURL:directory.appendingPathComponent(m.output),fileType:.mp4)
    writer.shouldOptimizeForNetworkUse=true
    let video=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:m.width,AVVideoHeightKey:m.height,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:450000,AVVideoProfileLevelKey:AVVideoProfileLevelH264HighAutoLevel]])
    let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:video,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:m.width,kCVPixelBufferHeightKey as String:m.height])
    writer.add(video)
    let asset=AVURLAsset(url:directory.appendingPathComponent(m.audio))
    guard let track=asset.tracks(withMediaType:.audio).first else { fail("Audio track missing") }
    let reader=try AVAssetReader(asset:asset)
    let audioOutput=AVAssetReaderTrackOutput(track:track,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMIsFloatKey:false,AVLinearPCMBitDepthKey:16,AVLinearPCMIsNonInterleaved:false])
    reader.add(audioOutput)
    let audio=AVAssetWriterInput(mediaType:.audio,outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:24000,AVNumberOfChannelsKey:1,AVEncoderBitRateKey:64000])
    writer.add(audio)
    guard writer.startWriting(), reader.startReading() else { fail("Encoder could not start: writer=\(String(describing:writer.error)) reader=\(String(describing:reader.error))") }
    writer.startSession(atSourceTime:.zero)
    let group=DispatchGroup(), lock=NSLock(); var failure: String?
    func recordError(_ s:String) { lock.lock(); failure=s; lock.unlock() }
    let videoQueue=DispatchQueue(label:"tenetko.video"), audioQueue=DispatchQueue(label:"tenetko.audio")
    var sample=0, frameIndex=0, cachedIndex = -1, cached: CVPixelBuffer?
    let total=Int(ceil(m.duration*Double(m.fps)))
    group.enter()
    video.requestMediaDataWhenReady(on:videoQueue) {
        while video.isReadyForMoreMediaData {
            if sample>=total { video.markAsFinished(); group.leave(); return }
            let time=Double(sample)/Double(m.fps)
            while frameIndex+1<m.frames.count && m.frames[frameIndex+1].time<=time { frameIndex+=1 }
            if cachedIndex != frameIndex {
                guard let source=CGImageSourceCreateWithURL(directory.appendingPathComponent(m.frames[frameIndex].file) as CFURL,nil), let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {
                    recordError("Cannot load frame"); video.markAsFinished(); group.leave(); return
                }
                var buffer: CVPixelBuffer?
                CVPixelBufferCreate(kCFAllocatorDefault,m.width,m.height,kCVPixelFormatType_32BGRA,[kCVPixelBufferCGImageCompatibilityKey:true,kCVPixelBufferCGBitmapContextCompatibilityKey:true] as CFDictionary,&buffer)
                guard let b=buffer else { recordError("Pixel buffer allocation failed"); video.markAsFinished(); group.leave(); return }
                CVPixelBufferLockBaseAddress(b,[])
                guard let context=CGContext(data:CVPixelBufferGetBaseAddress(b),width:m.width,height:m.height,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(b),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { fail("Image context failed") }
                context.draw(image,in:CGRect(x:0,y:0,width:m.width,height:m.height))
                CVPixelBufferUnlockBaseAddress(b,[]); cached=b; cachedIndex=frameIndex
            }
            guard adaptor.append(cached!,withPresentationTime:CMTime(value:Int64(sample),timescale:Int32(m.fps))) else {
                recordError("\(writer.error?.localizedDescription ?? "Video encoding failed")"); video.markAsFinished(); group.leave(); return
            }
            sample+=1
        }
    }
    group.enter()
    audio.requestMediaDataWhenReady(on:audioQueue) {
        while audio.isReadyForMoreMediaData {
            guard let buffer=audioOutput.copyNextSampleBuffer() else { audio.markAsFinished(); group.leave(); return }
            if !audio.append(buffer) { recordError("Audio encoding failed"); audio.markAsFinished(); group.leave(); return }
        }
    }
    group.notify(queue:.main) {
        if let f=failure { writer.cancelWriting(); fail(f) }
        writer.endSession(atSourceTime:CMTime(seconds:m.duration,preferredTimescale:24000))
        writer.finishWriting {
            if writer.status != .completed { fail(writer.error?.localizedDescription ?? "Video export failed") }
            print("{\"done\":true}"); exit(0)
        }
    }
    RunLoop.main.run()
} catch { fail("\(error)") }
