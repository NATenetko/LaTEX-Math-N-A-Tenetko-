'use strict';
// Speech-only transformations from the user's Scientific Reader index.html.
// These helpers receive copied strings, never mutable document or MathBlock objects.
(function () {
function extractBraced(
    text,
    start
) {

    if (
        text[start] !== "{"
    ) {

        return null;

    }


    let depth =
        0;


    for (
        let i = start;
        i < text.length;
        i++
    ) {

        if (
            text[i] === "{"
        ) {

            depth++;

        }

        else if (
            text[i] === "}"
        ) {

            depth--;


            if (
                depth === 0
            ) {

                return {

                    content:
                        text.slice(
                            start + 1,
                            i
                        ),

                    end:
                        i

                };

            }

        }

    }


    return null;

}


function replaceCommandOneArg(
    input,
    command,
    callback
) {

    let text =
        input;


    const token =
        "\\" + command;


    let start =
        text.indexOf(
            token
        );


    while (
        start !== -1
    ) {

        const brace =
            text.indexOf(
                "{",
                start
                +
                token.length
            );


        if (
            brace === -1
        ) {
            break;
        }


        const parsed =
            extractBraced(
                text,
                brace
            );


        if (!parsed) {
            break;
        }


        const replacement =
            callback(
                parsed.content
            );


        text =
            text.slice(
                0,
                start
            )
            +
            replacement
            +
            text.slice(
                parsed.end + 1
            );


        start =
            text.indexOf(
                token,
                start
                +
                replacement.length
            );

    }


    return text;

}


function replaceCommandTwoArgs(
    input,
    command,
    callback
) {

    let text =
        input;


    const token =
        "\\" + command;


    let start =
        text.indexOf(
            token
        );


    while (
        start !== -1
    ) {

        const firstBrace =
            text.indexOf(
                "{",
                start
                +
                token.length
            );


        if (
            firstBrace === -1
        ) {
            break;
        }


        const first =
            extractBraced(
                text,
                firstBrace
            );


        if (!first) {
            break;
        }


        const secondBrace =
            text.indexOf(
                "{",
                first.end + 1
            );


        if (
            secondBrace === -1
        ) {
            break;
        }


        const second =
            extractBraced(
                text,
                secondBrace
            );


        if (!second) {
            break;
        }


        const replacement =
            callback(
                first.content,
                second.content
            );


        text =
            text.slice(
                0,
                start
            )
            +
            replacement
            +
            text.slice(
                second.end + 1
            );


        start =
            text.indexOf(
                token,
                start
                +
                replacement.length
            );

    }


    return text;

}


/* =========================================================
   ENGLISH MATHEMATICAL SPEECH
========================================================= */

function mathToEnglish(
    latex
) {

    let text =
        String(
            latex || ""
        );


    /*
        Transport artifact.
    */

    text =
        text.replace(
            /\\=/g,
            "="
        );


    /*
        Cosmetic sizing.
    */

    text =
        text.replace(
            /\\bigl|\\bigr|\\Bigl|\\Bigr|\\big|\\Big|\\left|\\right/g,
            ""
        );


    text =
        text.replace(
            /\\qquad|\\quad|\\,|\\;|\\:/g,
            " "
        );


    text =
        text.replace(
            /\\!/g,
            ""
        );


    /*
        CASES.
    */

    text =
        text.replace(
            /\\begin\s*\{cases\}([\s\S]*?)\\end\s*\{cases\}/g,
            (
                full,
                content
            ) => {

                const rows =
                    content
                        .split(
                            /\\\\(?:\[[^\]]*\])?/
                        )
                        .map(
                            x =>
                                x.trim()
                        )
                        .filter(Boolean);


                return rows
                    .map(
                        row => {

                            const parts =
                                row.split("&");


                            const result =
                                mathToEnglish(
                                    parts[0]
                                    ||
                                    ""
                                );


                            const condition =
                                mathToEnglish(
                                    parts[1]
                                    ||
                                    ""
                                );


                            if (
                                condition
                            ) {

                                return (
                                    result
                                    +
                                    " if "
                                    +
                                    condition
                                );

                            }


                            return result;

                        }
                    )
                    .join(
                        ". "
                    );

            }
        );


    /*
        MATRICES.
    */

    text =
        text.replace(
            /\\begin\s*\{(?:matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}([\s\S]*?)\\end\s*\{(?:matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/g,
            (
                full,
                content
            ) => {

                const rows =
                    content
                        .split(/\\\\/)
                        .map(
                            row =>
                                row.trim()
                        )
                        .filter(Boolean);


                return (
                    "matrix. "
                    +
                    rows
                        .map(
                            (
                                row,
                                index
                            ) =>
                                "row "
                                +
                                (
                                    index + 1
                                )
                                +
                                ": "
                                +
                                row
                                    .split("&")
                                    .map(
                                        cell =>
                                            mathToEnglish(
                                                cell
                                            )
                                    )
                                    .join(", ")
                        )
                        .join(". ")
                );

            }
        );


    /*
        Binomial.
    */

    text =
        replaceCommandTwoArgs(
            text,
            "binom",
            (
                n,
                k
            ) =>
                `${mathToEnglish(n)} choose ${mathToEnglish(k)}`
        );


    /*
        Fractions.
    */

    for (
        let i = 0;
        i < 12;
        i++
    ) {

        const old =
            text;


        text =
            replaceCommandTwoArgs(
                text,
                "frac",
                (
                    numerator,
                    denominator
                ) =>
                    `${mathToEnglish(
                        numerator
                    )} divided by ${mathToEnglish(
                        denominator
                    )}`
            );


        if (
            old === text
        ) {

            break;

        }

    }


    /*
        Text/style commands that should
        preserve their contents.
    */

    const preservingCommands =
        [
            "boxed",
            "mathrm",
            "mathbf",
            "mathit",
            "text",
            "operatorname"
        ];


    preservingCommands.forEach(
        command => {

            text =
                replaceCommandOneArg(
                    text,
                    command,
                    content =>
                        content
                );

        }
    );


    /*
        Calligraphic.
    */

    text =
        replaceCommandOneArg(
            text,
            "mathcal",
            content =>
                `calligraphic ${content}`
        );


    /*
        Roots.
    */

    text =
        replaceCommandOneArg(
            text,
            "sqrt",
            content =>
                `square root of ${mathToEnglish(
                    content
                )}`
        );


    /*
        Decorations.
    */

    text =
        replaceCommandOneArg(
            text,
            "vec",
            content =>
                `vector ${mathToEnglish(
                    content
                )}`
        );


    text =
        replaceCommandOneArg(
            text,
            "hat",
            content =>
                `${mathToEnglish(
                    content
                )} hat`
        );


    text =
        replaceCommandOneArg(
            text,
            "bar",
            content =>
                `${mathToEnglish(
                    content
                )} bar`
        );


    text =
        replaceCommandOneArg(
            text,
            "overline",
            content =>
                `${mathToEnglish(
                    content
                )} bar`
        );


    /*
        Floor / ceiling.
    */

    text =
        text.replace(
            /\\lfloor/g,
            " floor of "
        );


    text =
        text.replace(
            /\\rfloor/g,
            " "
        );


    text =
        text.replace(
            /\\lceil/g,
            " ceiling of "
        );


    text =
        text.replace(
            /\\rceil/g,
            " "
        );


    /*
        Advanced operators.
    */

    text =
        text.replace(
            /\\sum_\{([^{}]+)\}\^\{([^{}]+)\}/g,
            (
                full,
                low,
                high
            ) =>
                `sum from ${mathToEnglish(
                    low
                )} to ${mathToEnglish(
                    high
                )}`
        );


    text =
        text.replace(
            /\\prod_\{([^{}]+)\}\^\{([^{}]+)\}/g,
            (
                full,
                low,
                high
            ) =>
                `product from ${mathToEnglish(
                    low
                )} to ${mathToEnglish(
                    high
                )}`
        );


    text =
        text.replace(
            /\\int_\{([^{}]+)\}\^\{([^{}]+)\}/g,
            (
                full,
                low,
                high
            ) =>
                `integral from ${mathToEnglish(
                    low
                )} to ${mathToEnglish(
                    high
                )}`
        );


    text =
        text.replace(
            /\\lim_\{([^{}]+)\}/g,
            (
                full,
                condition
            ) =>
                `limit as ${mathToEnglish(
                    condition
                )}`
        );


    text =
        text.replace(
            /\\sum/g,
            " sum "
        );


    text =
        text.replace(
            /\\prod/g,
            " product "
        );


    text =
        text.replace(
            /\\int/g,
            " integral "
        );


    text =
        text.replace(
            /\\lim/g,
            " limit "
        );


    /*
        Superscripts.

        Do this before replacing minus.
    */

    text =
        text.replace(
            /\^\{([^{}]+)\}/g,
            (
                full,
                exponent
            ) => {

                const spoken =
                    mathToEnglish(
                        exponent
                    );


                if (
                    spoken === "2"
                    ||
                    spoken === "two"
                ) {

                    return " squared ";

                }


                if (
                    spoken === "3"
                    ||
                    spoken === "three"
                ) {

                    return " cubed ";

                }


                return (
                    " to the power of "
                    +
                    spoken
                    +
                    " "
                );

            }
        );


    text =
        text.replace(
            /\^([A-Za-z0-9])/g,
            (
                full,
                exponent
            ) =>
                " to the power of "
                +
                mathToEnglish(
                    exponent
                )
                +
                " "
        );


    /*
        Subscripts:
        d_i -> d sub i
    */

    text =
        text.replace(
            /_\{([^{}]+)\}/g,
            (
                full,
                value
            ) =>
                " sub "
                +
                mathToEnglish(
                    value
                )
                +
                " "
        );


    text =
        text.replace(
            /_([A-Za-z0-9])/g,
            (
                full,
                value
            ) =>
                " sub "
                +
                mathToEnglish(
                    value
                )
                +
                " "
        );


    /*
        Functions.

        P(X) -> P of X
        I(P(X)) -> I of P of X
    */

    for (
        let pass = 0;
        pass < 15;
        pass++
    ) {

        const old =
            text;


        text =
            text.replace(
                /\b([A-Za-z])\(([^()]+)\)/g,
                (
                    full,
                    name,
                    argument
                ) =>
                    `${name} of ${mathToEnglish(
                        argument
                    )}`
            );


        if (
            old === text
        ) {

            break;

        }

    }


    /*
        Greek.
    */

    const greek =
        {

            alpha:
                "alpha",

            beta:
                "beta",

            gamma:
                "gamma",

            Gamma:
                "gamma",

            delta:
                "delta",

            Delta:
                "delta",

            epsilon:
                "epsilon",

            theta:
                "theta",

            lambda:
                "lambda",

            mu:
                "mu",

            nu:
                "nu",

            xi:
                "xi",

            pi:
                "pi",

            rho:
                "rho",

            sigma:
                "sigma",

            Sigma:
                "sigma",

            tau:
                "tau",

            phi:
                "phi",

            psi:
                "psi",

            omega:
                "omega",

            Omega:
                "omega"

        };


    Object.entries(
        greek
    )
    .forEach(
        (
            [
                command,
                spoken
            ]
        ) => {

            text =
                text.replace(
                    new RegExp(
                        "\\\\"
                        +
                        command
                        +
                        "\\b",
                        "g"
                    ),
                    " "
                    +
                    spoken
                    +
                    " "
                );

        }
    );


    /*
        IMPORTANT mathematical relations.

        \leftrightarrow is deliberately
        independent from >= and <=.
    */

    const symbols =
        [

            [
                /\\leftrightarrow/g,
                " is paired with "
            ],

            [
                /\\Leftrightarrow/g,
                " is equivalent to "
            ],

            [
                /\\notin/g,
                " is not an element of "
            ],

            [
                /\\neq/g,
                " is not equal to "
            ],

            [
                /\\geq|\\ge/g,
                " is greater than or equal to "
            ],

            [
                /\\leq|\\le/g,
                " is less than or equal to "
            ],

            [
                /\\approx/g,
                " is approximately equal to "
            ],

            [
                /\\equiv/g,
                " is identically equal to "
            ],

            [
                /\\rightarrow|\\Rightarrow/g,
                " implies "
            ],

            [
                /\\leftarrow|\\Leftarrow/g,
                " follows from "
            ],

            [
                /\\to/g,
                " tends to "
            ],

            [
                /\\in/g,
                " is an element of "
            ],

            [
                /\\subseteq/g,
                " is a subset of or equal to "
            ],

            [
                /\\subset/g,
                " is a subset of "
            ],

            [
                /\\supseteq/g,
                " contains or equals "
            ],

            [
                /\\supset/g,
                " contains "
            ],

            [
                /\\cup/g,
                " union "
            ],

            [
                /\\cap/g,
                " intersection "
            ],

            [
                /\\setminus/g,
                " set minus "
            ],

            [
                /\\forall/g,
                " for every "
            ],

            [
                /\\exists/g,
                " there exists "
            ],

            [
                /\\nexists/g,
                " there does not exist "
            ],

            [
                /\\infty/g,
                " infinity "
            ],

            [
                /\\cdot|\\times/g,
                " times "
            ],

            [
                /\\div/g,
                " divided by "
            ],

            [
                /\\pm/g,
                " plus or minus "
            ],

            [
                /\\partial/g,
                " partial "
            ],

            [
                /\\nabla/g,
                " nabla "
            ]

        ];


    symbols.forEach(
        (
            [
                regex,
                replacement
            ]
        ) => {

            text =
                text.replace(
                    regex,
                    replacement
                );

        }
    );


    /*
        TeX line breaks.
    */

    text =
        text.replace(
            /\\\\(?:\[[^\]]*\])?/g,
            ". "
        );


    /*
        Binary strings MUST be read
        digit-by-digit.
    */

    text =
        text.replace(
            /\b[01]{2,}\b/g,
            binary =>
                binary
                    .split("")
                    .map(
                        digit =>
                            digit === "0"
                            ?
                            "zero"
                            :
                            "one"
                    )
                    .join(" ")
        );


    /*
        Remaining grouped braces.

        If comma exists, treat as a set.
        Otherwise braces are grouping only.
    */

    for (
        let pass = 0;
        pass < 8;
        pass++
    ) {

        const old =
            text;


        text =
            text.replace(
                /\{([^{}]*)\}/g,
                (
                    full,
                    content
                ) => {

                    if (
                        content.includes(",")
                    ) {

                        return (
                            " set containing "
                            +
                            content
                            +
                            " "
                        );

                    }


                    return (
                        " "
                        +
                        content
                        +
                        " "
                    );

                }
            );


        if (
            old === text
        ) {
            break;
        }

    }


    /*
        Ordinary operators.
    */

    text =
        text.replace(
            /=/g,
            " equals "
        );


    text =
        text.replace(
            /\+/g,
            " plus "
        );


    text =
        text.replace(
            /-/g,
            " minus "
        );


    text =
        text.replace(
            /\//g,
            " divided by "
        );


    text =
        text.replace(
            />/g,
            " is greater than "
        );


    text =
        text.replace(
            /</g,
            " is less than "
        );


    /*
        Parentheses left after
        function processing are grouping.
    */

    text =
        text.replace(
            /[\(\)]/g,
            " "
        );


    /*
        Remaining isolated digits.
    */

    const digits =
        {

            "0":
                "zero",

            "1":
                "one",

            "2":
                "two",

            "3":
                "three",

            "4":
                "four",

            "5":
                "five",

            "6":
                "six",

            "7":
                "seven",

            "8":
                "eight",

            "9":
                "nine"

        };


    Object.entries(
        digits
    )
    .forEach(
        (
            [
                digit,
                word
            ]
        ) => {

            text =
                text.replace(
                    new RegExp(
                        "\\b"
                        +
                        digit
                        +
                        "\\b",
                        "g"
                    ),
                    word
                );

        }
    );


    /*
        Remaining unknown commands
        are omitted instead of being
        spoken as backslash words.
    */

    text =
        text.replace(
            /\\[A-Za-z]+/g,
            " "
        );


    text =
        text.replace(
            /&/g,
            ", "
        );


    text =
        text.replace(
            /\$/g,
            ""
        );


    return cleanupSpeech(
        text
    );

}


/* =========================================================
   PLAIN TEXT SPEECH
========================================================= */

function cleanupSpeech(
    input
) {

    return String(
        input || ""
    )
        .replace(
            /\s+/g,
            " "
        )
        .replace(
            /\s+([,.!?;:])/g,
            "$1"
        )
        .replace(
            /\.\s*\./g,
            "."
        )
        .trim();

}


function cleanPlainSpeech(
    raw,
    lang
) {

    let text =
        String(
            raw || ""
        );


    text =
        text.replace(
            /\[([^\]]+)\]\([^)]+\)/g,
            "$1"
        );


    text =
        text.replace(
            /\*\*(.*?)\*\*/g,
            "$1"
        );


    text =
        text.replace(
            /__(.*?)__/g,
            "$1"
        );


    text =
        text.replace(
            /\*(.*?)\*/g,
            "$1"
        );


    text =
        text.replace(
            /`([^`]+)`/g,
            "$1"
        );


    /*
        Common operator-class notation.
    */

    if (
        lang === "en"
    ) {

        text =
            text.replace(
                /\bA\/B\/C\/D\b/g,
                "A, B, C, D"
            );

    }


    return cleanupSpeech(
        text
    );

}


/* =========================================================
   SPLIT PLAIN TEXT RU / EN
========================================================= */

function splitPlainSpeech(
    raw,
    absoluteStart,
    blockIndex
) {

    const pieces =
        [];


    const tokenRegex =
        /[A-Za-z]+(?:[-'][A-Za-z]+)*|[А-Яа-яЁё]+(?:[-'][А-Яа-яЁё]+)*|\d+|[^A-Za-zА-Яа-яЁё\d]+/g;


    let currentLang =
        null;

    let currentRaw =
        "";

    let currentStart =
        null;

    let currentEnd =
        null;


    function flush() {

        if (
            currentStart === null
        ) {

            return;

        }


        const speech =
            cleanPlainSpeech(
                currentRaw,
                currentLang || "ru"
            );


        if (speech) {

            pieces.push({

                kind:
                    "text",

                lang:
                    currentLang
                    ||
                    "ru",

                speechText:
                    speech,

                raw:
                    currentRaw,

                absStart:
                    absoluteStart
                    +
                    currentStart,

                absEnd:
                    absoluteStart
                    +
                    currentEnd,

                blockIndex

            });

        }


        currentLang =
            null;

        currentRaw =
            "";

        currentStart =
            null;

        currentEnd =
            null;

    }


    let match;


    while (
        (
            match =
                tokenRegex.exec(raw)
        )
        !== null
    ) {

        const token =
            match[0];


        let tokenLang =
            null;


        if (
            /[А-Яа-яЁё]/.test(
                token
            )
        ) {

            tokenLang =
                "ru";

        }

        else if (
            /[A-Za-z]/.test(
                token
            )
        ) {

            tokenLang =
                "en";

        }


        if (
            tokenLang
            &&
            currentLang
            &&
            tokenLang !==
                currentLang
        ) {

            flush();

        }


        if (
            currentStart === null
        ) {

            currentStart =
                match.index;

        }


        if (
            tokenLang
            &&
            !currentLang
        ) {

            currentLang =
                tokenLang;

        }


        currentRaw +=
            token;


        currentEnd =
            match.index
            +
            token.length;

    }


    flush();


    return pieces;

}



const api = { mathToEnglish, splitPlainSpeech };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.MathSpeechAdapter = api;
})();

