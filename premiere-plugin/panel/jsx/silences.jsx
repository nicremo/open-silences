/**
 * Open Silences: host adapter for Premiere Pro (ExtendScript).
 *
 * The adapter only talks to the host. Every decision comes from the Rust engine
 * and from the panel core.
 *
 * Proven host behaviour (Premiere Pro 26.5.2, 25 fps, one video and one audio
 * track, zero point 01:00:00:00):
 * * sequence.clone() creates a real copy; the copy is identified by its
 *   sequenceID and opened with app.project.openSequence(id).
 * * QE razor takes a timecode RELATIVE to the sequence start. Adding the
 *   display offset made the call a silent no-op.
 * * razor(timecode, true, true) also cuts the linked audio of that boundary, so
 *   boundaries are deduplicated per track and verified afterwards.
 * * Removing the middle audio item with remove(false, true) and then the middle
 *   video item with remove(true, true) rippled both tracks exactly once.
 *
 * Not proven and therefore not used:
 * * generic multitrack or drop frame cutting,
 * * reading time remapping or the audible clip state (no getter on this host).
 *
 * Fail closed: unknown state blocks the cut. Nothing is guessed, nothing is
 * retried after an unexpected mutation result.
 */

// BEGIN bundled JSON2: ES3 support, Public Domain.
//  json2.js
//  2023-05-10
//  Public Domain.
//  NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.

//  USE YOUR OWN COPY. IT IS EXTREMELY UNWISE TO LOAD CODE FROM SERVERS YOU DO
//  NOT CONTROL.

//  This file creates a global JSON object containing two methods: stringify
//  and parse. This file provides the ES5 JSON capability to ES3 systems.
//  If a project might run on IE8 or earlier, then this file should be included.
//  This file does nothing on ES5 systems.

//      JSON.stringify(value, replacer, space)
//          value       any JavaScript value, usually an object or array.
//          replacer    an optional parameter that determines how object
//                      values are stringified for objects. It can be a
//                      function or an array of strings.
//          space       an optional parameter that specifies the indentation
//                      of nested structures. If it is omitted, the text will
//                      be packed without extra whitespace. If it is a number,
//                      it will specify the number of spaces to indent at each
//                      level. If it is a string (such as "\t" or "&nbsp;"),
//                      it contains the characters used to indent at each level.
//          This method produces a JSON text from a JavaScript value.
//          When an object value is found, if the object contains a toJSON
//          method, its toJSON method will be called and the result will be
//          stringified. A toJSON method does not serialize: it returns the
//          value represented by the name/value pair that should be serialized,
//          or undefined if nothing should be serialized. The toJSON method
//          will be passed the key associated with the value, and this will be
//          bound to the value.

//          For example, this would serialize Dates as ISO strings.

//              Date.prototype.toJSON = function (key) {
//                  function f(n) {
//                      // Format integers to have at least two digits.
//                      return (n < 10)
//                          ? "0" + n
//                          : n;
//                  }
//                  return this.getUTCFullYear()   + "-" +
//                       f(this.getUTCMonth() + 1) + "-" +
//                       f(this.getUTCDate())      + "T" +
//                       f(this.getUTCHours())     + ":" +
//                       f(this.getUTCMinutes())   + ":" +
//                       f(this.getUTCSeconds())   + "Z";
//              };

//          You can provide an optional replacer method. It will be passed the
//          key and value of each member, with this bound to the containing
//          object. The value that is returned from your method will be
//          serialized. If your method returns undefined, then the member will
//          be excluded from the serialization.

//          If the replacer parameter is an array of strings, then it will be
//          used to select the members to be serialized. It filters the results
//          such that only members with keys listed in the replacer array are
//          stringified.

//          Values that do not have JSON representations, such as undefined or
//          functions, will not be serialized. Such values in objects will be
//          dropped; in arrays they will be replaced with null. You can use
//          a replacer function to replace those with JSON values.

//          JSON.stringify(undefined) returns undefined.

//          The optional space parameter produces a stringification of the
//          value that is filled with line breaks and indentation to make it
//          easier to read.

//          If the space parameter is a non-empty string, then that string will
//          be used for indentation. If the space parameter is a number, then
//          the indentation will be that many spaces.

//          Example:

//          text = JSON.stringify(["e", {pluribus: "unum"}]);
//          // text is '["e",{"pluribus":"unum"}]'

//          text = JSON.stringify(["e", {pluribus: "unum"}], null, "\t");
//          // text is '[\n\t"e",\n\t{\n\t\t"pluribus": "unum"\n\t}\n]'

//          text = JSON.stringify([new Date()], function (key, value) {
//              return this[key] instanceof Date
//                  ? "Date(" + this[key] + ")"
//                  : value;
//          });
//          // text is '["Date(---current time---)"]'

//      JSON.parse(text, reviver)
//          This method parses a JSON text to produce an object or array.
//          It can throw a SyntaxError exception.

//          The optional reviver parameter is a function that can filter and
//          transform the results. It receives each of the keys and values,
//          and its return value is used instead of the original value.
//          If it returns what it received, then the structure is not modified.
//          If it returns undefined then the member is deleted.

//          Example:

//          // Parse the text. Values that look like ISO date strings will
//          // be converted to Date objects.

//          myData = JSON.parse(text, function (key, value) {
//              var a;
//              if (typeof value === "string") {
//                  a =
//   /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(value);
//                  if (a) {
//                      return new Date(Date.UTC(
//                         +a[1], +a[2] - 1, +a[3], +a[4], +a[5], +a[6]
//                      ));
//                  }
//                  return value;
//              }
//          });

//          myData = JSON.parse(
//              "[\"Date(09/09/2001)\"]",
//              function (key, value) {
//                  var d;
//                  if (
//                      typeof value === "string"
//                      && value.slice(0, 5) === "Date("
//                      && value.slice(-1) === ")"
//                  ) {
//                      d = new Date(value.slice(5, -1));
//                      if (d) {
//                          return d;
//                      }
//                  }
//                  return value;
//              }
//          );

//  This is a reference implementation. You are free to copy, modify, or
//  redistribute.

/*jslint
    eval, for, this
*/

/*property
    JSON, apply, call, charCodeAt, getUTCDate, getUTCFullYear, getUTCHours,
    getUTCMinutes, getUTCMonth, getUTCSeconds, hasOwnProperty, join,
    lastIndex, length, parse, prototype, push, replace, slice, stringify,
    test, toJSON, toString, valueOf
*/


// Create a JSON object only if one does not already exist. We create the
// methods in a closure to avoid creating global variables.

if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    "use strict";

    var rx_one = /^[\],:{}\s]*$/;
    var rx_two = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
    var rx_three = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
    var rx_four = /(?:^|:|,)(?:\s*\[)+/g;
    var rx_escapable = /[\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
    var rx_dangerous = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;

    function f(n) {
        // Format integers to have at least two digits.
        return (n < 10)
            ? "0" + n
            : n;
    }

    function this_value() {
        return this.valueOf();
    }

    if (typeof Date.prototype.toJSON !== "function") {

        Date.prototype.toJSON = function () {

            return isFinite(this.valueOf())
                ? (
                    this.getUTCFullYear()
                    + "-"
                    + f(this.getUTCMonth() + 1)
                    + "-"
                    + f(this.getUTCDate())
                    + "T"
                    + f(this.getUTCHours())
                    + ":"
                    + f(this.getUTCMinutes())
                    + ":"
                    + f(this.getUTCSeconds())
                    + "Z"
                )
                : null;
        };

        Boolean.prototype.toJSON = this_value;
        Number.prototype.toJSON = this_value;
        String.prototype.toJSON = this_value;
    }

    var gap;
    var indent;
    var meta;
    var rep;


    function quote(string) {

// If the string contains no control characters, no quote characters, and no
// backslash characters, then we can safely slap some quotes around it.
// Otherwise we must also replace the offending characters with safe escape
// sequences.

        rx_escapable.lastIndex = 0;
        return rx_escapable.test(string)
            ? "\"" + string.replace(rx_escapable, function (a) {
                var c = meta[a];
                return typeof c === "string"
                    ? c
                    : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\""
            : "\"" + string + "\"";
    }


    function str(key, holder) {

// Produce a string from holder[key].

        var i;          // The loop counter.
        var k;          // The member key.
        var v;          // The member value.
        var length;
        var mind = gap;
        var partial;
        var value = holder[key];

// If the value has a toJSON method, call it to obtain a replacement value.

        if (
            value
            && typeof value === "object"
            && typeof value.toJSON === "function"
        ) {
            value = value.toJSON(key);
        }

// If we were called with a replacer function, then call the replacer to
// obtain a replacement value.

        if (typeof rep === "function") {
            value = rep.call(holder, key, value);
        }

// What happens next depends on the value's type.

        switch (typeof value) {
        case "string":
            return quote(value);

        case "number":

// JSON numbers must be finite. Encode non-finite numbers as null.

            return (isFinite(value))
                ? String(value)
                : "null";

        case "boolean":
        case "null":

// If the value is a boolean or null, convert it to a string. Note:
// typeof null does not produce "null". The case is included here in
// the remote chance that this gets fixed someday.

            return String(value);

// If the type is "object", we might be dealing with an object or an array or
// null.

        case "object":

// Due to a specification blunder in ECMAScript, typeof null is "object",
// so watch out for that case.

            if (!value) {
                return "null";
            }

// Make an array to hold the partial results of stringifying this object value.

            gap += indent;
            partial = [];

// Is the value an array?

            if (Object.prototype.toString.apply(value) === "[object Array]") {

// The value is an array. Stringify every element. Use null as a placeholder
// for non-JSON values.

                length = value.length;
                for (i = 0; i < length; i += 1) {
                    partial[i] = str(i, value) || "null";
                }

// Join all of the elements together, separated with commas, and wrap them in
// brackets.

                v = partial.length === 0
                    ? "[]"
                    : gap
                        ? (
                            "[\n"
                            + gap
                            + partial.join(",\n" + gap)
                            + "\n"
                            + mind
                            + "]"
                        )
                        : "[" + partial.join(",") + "]";
                gap = mind;
                return v;
            }

// If the replacer is an array, use it to select the members to be stringified.

            if (rep && typeof rep === "object") {
                length = rep.length;
                for (i = 0; i < length; i += 1) {
                    if (typeof rep[i] === "string") {
                        k = rep[i];
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (
                                (gap)
                                    ? ": "
                                    : ":"
                            ) + v);
                        }
                    }
                }
            } else {

// Otherwise, iterate through all of the keys in the object.

                for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (
                                (gap)
                                    ? ": "
                                    : ":"
                            ) + v);
                        }
                    }
                }
            }

// Join all of the member texts together, separated with commas,
// and wrap them in braces.

            v = partial.length === 0
                ? "{}"
                : gap
                    ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
                    : "{" + partial.join(",") + "}";
            gap = mind;
            return v;
        }
    }

// If the JSON object does not yet have a stringify method, give it one.

    if (typeof JSON.stringify !== "function") {
        meta = {    // table of character substitutions
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            "\"": "\\\"",
            "\\": "\\\\"
        };
        JSON.stringify = function (value, replacer, space) {

// The stringify method takes a value and an optional replacer, and an optional
// space parameter, and returns a JSON text. The replacer can be a function
// that can replace values, or an array of strings that will select the keys.
// A default replacer method can be provided. Use of the space parameter can
// produce text that is more easily readable.

            var i;
            gap = "";
            indent = "";

// If the space parameter is a number, make an indent string containing that
// many spaces.

            if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                    indent += " ";
                }

// If the space parameter is a string, it will be used as the indent string.

            } else if (typeof space === "string") {
                indent = space;
            }

// If there is a replacer, it must be a function or an array.
// Otherwise, throw an error.

            rep = replacer;
            if (replacer && typeof replacer !== "function" && (
                typeof replacer !== "object"
                || typeof replacer.length !== "number"
            )) {
                throw new Error("JSON.stringify");
            }

// Make a fake root object containing our value under the key of "".
// Return the result of stringifying the value.

            return str("", {"": value});
        };
    }


// If the JSON object does not yet have a parse method, give it one.

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text, reviver) {

// The parse method takes a text and an optional reviver function, and returns
// a JavaScript value if the text is a valid JSON text.

            var j;

            function walk(holder, key) {

// The walk method is used to recursively walk the resulting structure so
// that modifications can be made.

                var k;
                var v;
                var value = holder[key];
                if (value && typeof value === "object") {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }


// Parsing happens in four stages. In the first stage, we replace certain
// Unicode characters with escape sequences. JavaScript handles many characters
// incorrectly, either silently deleting them, or treating them as line endings.

            text = String(text);
            rx_dangerous.lastIndex = 0;
            if (rx_dangerous.test(text)) {
                text = text.replace(rx_dangerous, function (a) {
                    return (
                        "\\u"
                        + ("0000" + a.charCodeAt(0).toString(16)).slice(-4)
                    );
                });
            }

// In the second stage, we run the text against regular expressions that look
// for non-JSON patterns. We are especially concerned with "()" and "new"
// because they can cause invocation, and "=" because it can cause mutation.
// But just to be safe, we want to reject all unexpected forms.

// We split the second stage into 4 regexp operations in order to work around
// crippling inefficiencies in IE's and Safari's regexp engines. First we
// replace the JSON backslash pairs with "@" (a non-JSON character). Second, we
// replace all simple value tokens with "]" characters. Third, we delete all
// open brackets that follow a colon or comma or that begin the text. Finally,
// we look to see that the remaining characters are only whitespace or "]" or
// "," or ":" or "{" or "}". If that is so, then the text is safe for eval.

            if (
                rx_one.test(
                    text
                        .replace(rx_two, "@")
                        .replace(rx_three, "]")
                        .replace(rx_four, "")
                )
            ) {

// In the third stage we use the eval function to compile the text into a
// JavaScript structure. The "{" operator is subject to a syntactic ambiguity
// in JavaScript: it can begin a block or an object literal. We wrap the text
// in parens to eliminate the ambiguity.

                j = eval("(" + text + ")");

// In the optional fourth stage, we recursively walk the new structure, passing
// each name/value pair to a reviver function for possible transformation.

                return (typeof reviver === "function")
                    ? walk({"": j}, "")
                    : j;
            }

// If the text is not JSON parseable, then a SyntaxError is thrown.

            throw new SyntaxError("JSON.parse");
        };
    }
}());

// END bundled JSON2.

/* ------------------------------------------------------------------ utils */

function os_pad2(value) {
  return (value < 10 ? '0' : '') + value;
}

/** JSON with a clear error when the host has no usable JSON. */
function os_json(value) {
  if (typeof JSON === 'undefined' || !JSON.stringify) {
    return '{"ok":false,"error":"JSON ist in dieser ExtendScript Umgebung nicht verfügbar."}';
  }
  return JSON.stringify(value);
}

function os_fail(message) {
  return os_json({ ok: false, error: message });
}

function os_read(read) {
  try {
    return { value: read() };
  } catch (error) {
    return { error: String(error) };
  }
}

function os_flag(read) {
  var result = os_read(read);
  if (result.error || result.value === undefined || result.value === null) {
    return null;
  }
  if (result.value === true || result.value === 1) {
    return true;
  }
  if (result.value === false || result.value === 0) {
    return false;
  }
  return null;
}

/** Strict boolean, used where the engine requires true or false. */
function os_requiredBoolean(read, field) {
  var result = os_read(read);
  if (result.error) {
    throw new Error(field + ' ist nicht lesbar: ' + result.error);
  }
  if (result.value === true || result.value === 1) {
    return true;
  }
  if (result.value === false || result.value === 0) {
    return false;
  }
  throw new Error(field + ' ist nicht lesbar oder ungültig (' + String(result.value) + ').');
}

/**
 * Exact decimal comparison of tick strings. ExtendScript numbers cannot hold
 * ticks beyond 2^53, therefore the digits are compared directly. Negative or
 * malformed values are refused instead of being interpreted.
 */
function os_compareTicks(first, second) {
  var a = String(first);
  var b = String(second);
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) {
    throw new Error('Tickwert ist keine nicht negative Dezimalzahl: ' + a + ' / ' + b);
  }
  var trimmedA = a.replace(/^0+(?=[0-9])/, '');
  var trimmedB = b.replace(/^0+(?=[0-9])/, '');
  if (trimmedA.length !== trimmedB.length) {
    return trimmedA.length < trimmedB.length ? -1 : 1;
  }
  if (trimmedA === trimmedB) {
    return 0;
  }
  return trimmedA < trimmedB ? -1 : 1;
}

/* ------------------------------------------------------- identity and time */

/** Identity of a sequence: document plus sequenceID, never a name. */
function os_identity(sequence) {
  var documentId = os_read(function () {
    return app.project.documentID;
  });
  if (documentId.error || documentId.value === undefined || documentId.value === null) {
    return null;
  }
  var sequenceId = os_read(function () {
    return sequence.sequenceID;
  });
  if (sequenceId.error || sequenceId.value === undefined || sequenceId.value === null) {
    return null;
  }
  return String(documentId.value) + ':' + String(sequenceId.value);
}

function os_sequenceIds() {
  var ids = [];
  var sequences = app.project.sequences;
  for (var index = 0; index < sequences.numSequences; index++) {
    ids.push(String(sequences[index].sequenceID));
  }
  return ids;
}

function os_findSequence(sequenceId) {
  var sequences = app.project.sequences;
  for (var index = 0; index < sequences.numSequences; index++) {
    if (String(sequences[index].sequenceID) === String(sequenceId)) {
      return sequences[index];
    }
  }
  return null;
}

/**
 * Timecode from a frame index. The engine computed the frame with exact integer
 * arithmetic, so no tick value above 2^53 is ever divided here.
 */
function os_timecodeFromFrames(frames, fps) {
  if (!(frames >= 0) || !(fps > 0)) {
    return null;
  }
  var perSecond = Math.round(fps);
  if (perSecond <= 0 || Math.abs(perSecond - fps) > 1e-6) {
    return null;
  }
  var totalSeconds = Math.floor(frames / perSecond);
  return (
    os_pad2(Math.floor(totalSeconds / 3600)) +
    ':' +
    os_pad2(Math.floor(totalSeconds / 60) % 60) +
    ':' +
    os_pad2(totalSeconds % 60) +
    ':' +
    os_pad2(frames % perSecond)
  );
}

/** Rational frame rate. Drop frame rates are reported but never used. */
function os_frameRate(sequence) {
  var seconds = sequence.getSettings().videoFrameRate.seconds;
  if (!seconds || seconds <= 0) {
    return null;
  }
  var fps = 1 / seconds;
  var candidates = [
    [30000, 1001],
    [24000, 1001],
    [60000, 1001],
    [48000, 1001]
  ];
  for (var index = 0; index < candidates.length; index++) {
    var ratio = candidates[index][0] / candidates[index][1];
    if (Math.abs(ratio - fps) < 0.001) {
      return {
        numerator: candidates[index][0],
        denominator: candidates[index][1],
        fps: ratio,
        dropFrame: true
      };
    }
  }
  var rounded = Math.round(fps);
  if (Math.abs(rounded - fps) < 1e-6) {
    return { numerator: rounded, denominator: 1, fps: fps, dropFrame: false };
  }
  return { numerator: Math.round(fps * 1000), denominator: 1000, fps: fps, dropFrame: true };
}

/* --------------------------------------------------------- reading the host */

/**
 * Track flags and transition count.
 *
 * Transitions are counted with the QE reader (`numTransitions`). The public
 * clip list does NOT contain transitions, so a clip type never proves their
 * absence. An unreadable count stays unknown.
 */
function os_trackState(sequence, qeSequence, kind, index) {
  var collection = kind === 'video' ? sequence.videoTracks : sequence.audioTracks;
  var track = collection[index];
  var locked = os_flag(function () {
    return track.isLocked();
  });
  var muted = os_flag(function () {
    return track.isMuted();
  });
  var transitions = null;
  if (qeSequence) {
    var qeTrack =
      kind === 'video' ? qeSequence.getVideoTrackAt(index) : qeSequence.getAudioTrackAt(index);
    if (locked === null) {
      locked = os_flag(function () {
        return qeTrack.isLocked();
      });
    }
    if (muted === null) {
      muted = os_flag(function () {
        return qeTrack.isMuted();
      });
    }
    var count = os_read(function () {
      return qeTrack.numTransitions;
    });
    if (!count.error && count.value !== undefined && count.value !== null) {
      transitions = Number(count.value);
      if (!isFinite(transitions) || transitions < 0 || transitions > 100000 || Math.floor(transitions) !== transitions) {
        transitions = null;
      } else if (typeof qeTrack.getTransitionAt === 'function') {
        // QE counts gaps on its transition lane. An Empty sentinel is not a
        // transition, including the terminal gap of an otherwise empty lane.
        var realTransitions = 0;
        for (var ti = 0; ti < transitions; ti++) {
          var transition = os_read(function () { return qeTrack.getTransitionAt(ti); });
          if (transition.error || !transition.value) { realTransitions = null; break; }
          var type = String(transition.value.type);
          if (type === 'Transition') realTransitions++;
          else if (type !== 'Empty') { realTransitions = null; break; }
        }
        transitions = realTransitions;
      }
    }
  }
  return { locked: locked, muted: muted, transitions: transitions };
}

/**
 * Time remapping has no getter on the public clip or on the QE clip. Finding a
 * remap component proves true, absence proves nothing and stays unknown.
 */
function os_timeRemap(clip) {
  var components = os_read(function () {
    return clip.components;
  });
  if (components.error || !components.value) {
    return null;
  }
  var list = components.value;
  var count = os_read(function () {
    return list.numItems;
  });
  var length = count.error || count.value === undefined ? list.length : count.value;
  if (length === undefined || length === null) {
    return null;
  }
  for (var index = 0; index < length; index++) {
    var component = list[index];
    if (!component) {
      continue;
    }
    var display = os_read(function () {
      return component.displayName;
    });
    var match = os_read(function () {
      return component.matchName;
    });
    if (
      (String(display.value || '') + ' ' + String(match.value || '')).toLowerCase().indexOf('remap') >= 0
    ) {
      return true;
    }
  }
  return null;
}

function os_readClip(clip, trackKind, trackIndex, trackHasTransitions) {
  var name = os_read(function () {
    return clip.name;
  });
  var start = os_read(function () {
    return clip.start.ticks;
  });
  var end = os_read(function () {
    return clip.end.ticks;
  });
  var inPoint = os_read(function () {
    return clip.inPoint;
  });
  var outPoint = os_read(function () {
    return clip.outPoint;
  });
  if (start.error || end.error || inPoint.error || outPoint.error) {
    throw new Error('Clipposition auf ' + trackKind + trackIndex + ' ist nicht lesbar.');
  }
  var sourceIn = os_read(function () {
    return inPoint.value.ticks;
  });
  var sourceOut = os_read(function () {
    return outPoint.value.ticks;
  });
  var speed = os_read(function () {
    return clip.getSpeed();
  });
  var reversed = os_flag(function () {
    return clip.isSpeedReversed();
  });
  var disabled = os_requiredBoolean(function () {
    return clip.disabled;
  }, 'Deaktiviert-Status');
  var projectItem = os_read(function () {
    return clip.projectItem;
  });
  var mediaPath = null;
  var projectItemId = null;
  var nested = null;
  if (!projectItem.error && projectItem.value) {
    var path = os_read(function () {
      return projectItem.value.getMediaPath();
    });
    mediaPath = path.error ? null : path.value || null;
    var nodeId = os_read(function () {
      return projectItem.value.nodeId;
    });
    projectItemId = nodeId.error || nodeId.value === undefined ? null : String(nodeId.value);
    var isSequence = os_read(function () {
      return projectItem.value.isSequence();
    });
    if (!isSequence.error) {
      nested = isSequence.value === true;
    }
  }
  var linked = os_flag(function () {
    return clip.isLinked ? clip.isLinked() : null;
  });
  return {
    id: String(name.value || 'clip') + '@' + trackKind + trackIndex,
    startTicks: String(start.value),
    endTicks: String(end.value),
    sourceInTicks: sourceIn.error ? null : String(sourceIn.value),
    sourceOutTicks: sourceOut.error ? null : String(sourceOut.value),
    inPointSeconds: inPoint.value.seconds,
    outPointSeconds: outPoint.value.seconds,
    speed: speed.error ? null : speed.value,
    reversed: reversed,
    // Never false: this host has no remap reader.
    timeRemap: os_timeRemap(clip),
    nested: nested,
    transitionIn: trackHasTransitions === null ? null : trackHasTransitions,
    transitionOut: trackHasTransitions === null ? null : trackHasTransitions,
    mediaPath: mediaPath,
    projectItemId: projectItemId,
    disabled: disabled,
    linked: linked,
    // No reader on this host, therefore unknown.
    gainDb: null,
    audioEffects: null,
    channelMappingChanged: null
  };
}

function os_readTracks(sequence, qeSequence) {
  var tracks = [];
  var kinds = ['video', 'audio'];
  for (var kindIndex = 0; kindIndex < kinds.length; kindIndex++) {
    var kind = kinds[kindIndex];
    var collection = kind === 'video' ? sequence.videoTracks : sequence.audioTracks;
    var total = collection.numTracks;
    for (var index = 0; index < total; index++) {
      var state = os_trackState(sequence, qeSequence, kind, index);
      var track = collection[index];
      var clips = [];
      var clipCount = track.clips.numItems;
      for (var clipIndex = 0; clipIndex < clipCount; clipIndex++) {
        clips.push(
          os_readClip(
            track.clips[clipIndex],
            kind,
            index,
            state.transitions === null ? null : state.transitions > 0
          )
        );
      }
      tracks.push({
        kind: kind,
        index: index,
        name: String(track.name || kind + index),
        locked: state.locked,
        muted: state.muted,
        transitions: state.transitions,
        role: kind === 'audio' && index === 0 ? 'dialogue' : 'other',
        clips: clips
      });
    }
  }
  return tracks;
}

/** Item readback with full provenance, used for planning and verification. */
function os_readItemsOf(sequence) {
  var tracks = [];
  var kinds = ['video', 'audio'];
  for (var kindIndex = 0; kindIndex < kinds.length; kindIndex++) {
    var kind = kinds[kindIndex];
    var collection = kind === 'video' ? sequence.videoTracks : sequence.audioTracks;
    for (var index = 0; index < collection.numTracks; index++) {
      var clips = collection[index].clips;
      var items = [];
      for (var clipIndex = 0; clipIndex < clips.numItems; clipIndex++) {
        var clip = clips[clipIndex];
        var start = os_read(function () {
          return clip.start.ticks;
        });
        var end = os_read(function () {
          return clip.end.ticks;
        });
        var sourceIn = os_read(function () {
          return clip.inPoint.ticks;
        });
        var sourceOut = os_read(function () {
          return clip.outPoint.ticks;
        });
        if (start.error || end.error || sourceIn.error || sourceOut.error) {
          throw new Error('Positionen auf ' + kind + index + ' sind nicht lesbar.');
        }
        var projectItem = os_read(function () {
          return clip.projectItem;
        });
        var mediaPath = null;
        var projectItemId = null;
        if (!projectItem.error && projectItem.value) {
          var path = os_read(function () {
            return projectItem.value.getMediaPath();
          });
          mediaPath = path.error ? null : path.value || null;
          var nodeId = os_read(function () {
            return projectItem.value.nodeId;
          });
          projectItemId = nodeId.error || nodeId.value === undefined ? null : String(nodeId.value);
        }
        var speed = os_read(function () {
          return clip.getSpeed();
        });
        // An unreadable disabled state stays unknown, it is never reported as
        // "enabled".
        items.push({
          startTicks: String(start.value),
          endTicks: String(end.value),
          sourceInTicks: String(sourceIn.value),
          sourceOutTicks: String(sourceOut.value),
          mediaPath: mediaPath,
          projectItemId: projectItemId,
          disabled: os_flag(function () {
            return clip.disabled;
          }),
          speed: speed.error ? null : speed.value
        });
      }
      tracks.push({ kind: kind, index: index, items: items });
    }
  }
  return tracks;
}

/**
 * The single readback envelope. Every place that produces a fingerprint uses
 * exactly this helper, so two readbacks of the same sequence yield byte
 * identical text while different sequences stay distinguishable by identity.
 */
function os_itemEnvelope(sequence) {
  return os_json({
    ok: true,
    identity: os_identity(sequence),
    sequenceID: String(sequence.sequenceID),
    tracks: os_readItemsOf(sequence)
  });
}

/* ------------------------------------------------------------- panel calls */

/** OS_readSequence: read only snapshot plus the honest capability report. */
function OS_readSequence() {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) {
      return os_fail('Keine aktive Sequenz.');
    }
    var qeSequence = null;
    try {
      app.enableQE();
      qeSequence = qe.project.getActiveSequence();
    } catch (qeError) {
      qeSequence = null;
    }
    var frameRate = os_frameRate(sequence);
    if (!frameRate) {
      return os_fail('Bildrate der Sequenz ist nicht lesbar.');
    }
    var zeroPoint = os_read(function () {
      return sequence.zeroPoint;
    });
    var endTicks = os_read(function () {
      return sequence.end;
    });
    var tracks = os_readTracks(sequence, qeSequence);
    var sourceTicksReadable = true;
    var mediaIdentityReadable = true;
    var transitionsReadable = true;
    var linkedReadable = true;
    var clipCount = 0;
    for (var trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      if (tracks[trackIndex].transitions === null) {
        transitionsReadable = false;
      }
      for (var clipIndex = 0; clipIndex < tracks[trackIndex].clips.length; clipIndex++) {
        var entry = tracks[trackIndex].clips[clipIndex];
        clipCount++;
        if (!entry.sourceInTicks || !entry.sourceOutTicks) {
          sourceTicksReadable = false;
        }
        if (!entry.mediaPath || !entry.projectItemId) {
          mediaIdentityReadable = false;
        }
        if (entry.linked === null || entry.linked === undefined) {
          linkedReadable = false;
        }
      }
    }
    var documentId = os_read(function () {
      return app.project.documentID;
    });
    return os_json({
      ok: true,
      identity: os_identity(sequence),
      documentID: documentId.error ? null : String(documentId.value),
      sequenceID: String(sequence.sequenceID),
      name: String(sequence.name),
      fpsNumerator: frameRate.numerator,
      fpsDenominator: frameRate.denominator,
      fps: frameRate.fps,
      dropFrame: frameRate.dropFrame,
      zeroPointTicks: String(zeroPoint.error ? 0 : zeroPoint.value),
      endTicks: String(endTicks.error ? 0 : endTicks.value),
      qeAvailable: qeSequence !== null,
      // Only the observed rate counts as supported, matching the panel gate.
      fpsSupported: os_cutRateSupported(frameRate),
      fpsObserved: !frameRate.dropFrame && Math.abs(frameRate.fps - 25) < 1e-6,
      sourceTicksReadable: clipCount > 0 && sourceTicksReadable,
      mediaIdentityReadable: clipCount > 0 && mediaIdentityReadable,
      transitionsReadable: transitionsReadable,
      linkedReadable: clipCount > 0 && linkedReadable,
      timeRemapReadable: false,
      audioStateReadable: false,
      nativeTimelineAvailable: typeof sequence.exportAsMediaDirect === 'function' && os_wavePreset() !== null,
      sections: os_readSections(sequence),
      clipCount: clipCount,
      tracks: tracks
    });
  } catch (error) {
    return os_fail('Sequenz konnte nicht gelesen werden: ' + String(error));
  }
}

/** OS_readItems: item snapshot of the active sequence. */
function OS_readItems() {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) {
      return os_fail('Keine aktive Sequenz.');
    }
    return os_itemEnvelope(sequence);
  } catch (error) {
    return os_fail('Positionen konnten nicht gelesen werden: ' + String(error));
  }
}

/** Read a protected sequence without changing the active timeline. */
function OS_readItemsOfSequence(sequenceId) {
  try {
    var sequence = os_findSequence(sequenceId);
    if (!sequence) return os_fail('Die geschützte Sequenz wurde nicht gefunden.');
    return os_itemEnvelope(sequence);
  } catch (error) { return os_fail('Sequenzprüfung fehlgeschlagen: ' + String(error)); }
}

/** Selection is read separately from clip provenance and never inferred. */
function os_readSections(sequence) {
  var inTicks = null, outTicks = null, selected = [], readable = true;
  try {
    var inTime = sequence.getInPointAsTime(), outTime = sequence.getOutPointAsTime();
    if (inTime.seconds >= 0) inTicks = String(inTime.ticks);
    if (outTime.seconds >= 0) outTicks = String(outTime.ticks);
  } catch (error) { readable = false; }
  try {
    var kinds = [sequence.videoTracks, sequence.audioTracks];
    for (var k = 0; k < kinds.length; k++) for (var t = 0; t < kinds[k].numTracks; t++) {
      var clips = kinds[k][t].clips;
      for (var c = 0; c < clips.numItems; c++) if (clips[c].isSelected()) {
        selected.push({startTicks:String(clips[c].start.ticks), endTicks:String(clips[c].end.ticks)});
      }
    }
  } catch (error) { readable = false; }
  return {inTicks:inTicks, outTicks:outTicks, selectedSections:selected, readable:readable};
}

/** Only newly created sequences are moved into plugin-owned bins. */
function os_pluginBin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    if (String(child.name) === name && Number(child.type) === 2) return child;
  }
  return root.createBin(name);
}

/** Make and verify the protected backup before rendering or cutting. */
function OS_prepareCut(payloadJson) {
  var target = app.project.activeSequence;
  try {
    var payload = JSON.parse(payloadJson);
    if (!target || os_identity(target) !== payload.expectedIdentity || OS_readSequence() !== payload.expectedStateFingerprint ||
        os_itemEnvelope(target) !== payload.expectedItemFingerprint) return os_fail('Die Auswahl hat sich geändert. Bitte Bereich erneut wählen.');
    var cloned = JSON.parse(OS_cloneSequence(payload.expectedIdentity, payload.expectedItemFingerprint));
    if (!cloned.ok) return os_fail(cloned.error);
    var backup = app.project.activeSequence;
    if (String(backup.sequenceID) === String(target.sequenceID) ||
        os_json(os_readItemsOf(backup)) !== os_json(os_readItemsOf(target))) return os_fail('Das Backup stimmt nicht mit der Sequenz überein.');
    var stamp = new Date();
    backup.name = String(target.name) + ' - Backup ' + stamp.getFullYear() + '-' + (stamp.getMonth()+1) + '-' + stamp.getDate() + ' ' + stamp.getHours() + ':' + stamp.getMinutes() + ':' + stamp.getSeconds();
    var bin = os_pluginBin('Open Silences Backups');
    if (!bin) return os_fail('Der Backup-Ordner konnte nicht angelegt werden.');
    backup.projectItem.moveBin(bin);
    var backupItems = os_itemEnvelope(backup);
    if (os_itemEnvelope(target) !== payload.expectedItemFingerprint) return os_fail('Die Sequenz hat sich beim Backup geändert.');
    return os_json({ok:true, backupId:String(backup.sequenceID), backupName:String(backup.name), backupItems:backupItems,
      targetId:String(target.sequenceID), targetIdentity:os_identity(target), targetItems:os_itemEnvelope(target)});
  } catch (error) { return os_fail('Backup fehlgeschlagen: ' + String(error)); }
  finally { if (target) app.project.openSequence(target.sequenceID); }
}

/**
 * OS_cloneSequence: native clone, identified by the fresh sequenceID.
 *
 * The original is only read. The copy is opened and compared with the original
 * readback before the panel is allowed to continue.
 */
function OS_cloneSequence(expectedIdentity, expectedFingerprint) {
  try {
    if (!expectedIdentity || !expectedFingerprint) {
      return os_fail('Erwartete Kennung oder Fingerabdruck fehlt, es wird nichts geklont.');
    }
    var original = app.project.activeSequence;
    if (!original) {
      return os_fail('Keine aktive Sequenz.');
    }
    var originalIdentity = os_identity(original);
    if (!originalIdentity) {
      return os_fail('Die Kennung der Originalsequenz ist nicht lesbar.');
    }
    if (expectedIdentity && originalIdentity !== expectedIdentity) {
      return os_fail('Die aktive Sequenz ist nicht die analysierte Sequenz. Es wird nichts geklont.');
    }
    var originalItems = os_itemEnvelope(original);
    if (expectedFingerprint && originalItems !== expectedFingerprint) {
      return os_fail('Die Originalsequenz hat sich seit der Analyse geändert. Es wird nichts geklont.');
    }
    var idsBefore = os_sequenceIds();

    var cloned = os_read(function () {
      return original.clone();
    });
    if (cloned.error) {
      return os_fail('Sequenz konnte nicht geklont werden: ' + cloned.error);
    }

    var idsAfter = os_sequenceIds();
    var cloneId = null;
    for (var index = 0; index < idsAfter.length; index++) {
      var known = false;
      for (var previous = 0; previous < idsBefore.length; previous++) {
        if (idsBefore[previous] === idsAfter[index]) {
          known = true;
          break;
        }
      }
      if (!known) {
        cloneId = idsAfter[index];
      }
    }
    if (!cloneId) {
      return os_fail('Die neue Sequenzkopie ließ sich nicht bestimmen.');
    }
    if (!app.project.openSequence(String(cloneId))) {
      return os_fail('Die Sequenzkopie konnte nicht geöffnet werden, es wird nichts geschnitten.');
    }
    var active = app.project.activeSequence;
    if (!active || String(active.sequenceID) !== String(cloneId)) {
      return os_fail('Die Sequenzkopie ist nicht aktiv, es wird nichts geschnitten.');
    }
    var cloneIdentity = os_identity(active);
    if (!cloneIdentity) {
      return os_fail('Die Kennung der Sequenzkopie ist nicht lesbar.');
    }
    var cloneItems = os_itemEnvelope(active);
    return os_json({
      ok: true,
      originalIdentity: originalIdentity,
      originalId: String(original.sequenceID),
      cloneIdentity: cloneIdentity,
      cloneId: String(cloneId),
      originalName: String(original.name),
      cloneName: String(active.name),
      originalItems: originalItems,
      cloneItems: cloneItems,
      message: 'Kopie als neue Sequenz erstellt und geöffnet.'
    });
  } catch (error) {
    return os_fail('Kopie konnte nicht erstellt werden: ' + String(error));
  }
}

/* ------------------------------------------------------------- the cutting */

/**
 * Lookup tables for one plan, built once. Removals are grouped per interval
 * and every razor tick lists each affected track once, in plan order.
 */
function os_indexPlan(plan) {
  var byInterval = {};
  var byTick = {};
  for (var r = 0; r < plan.removals.length; r++) {
    var removal = plan.removals[r];
    var removalKey = String(removal.startTicks) + '-' + String(removal.endTicks);
    if (!byInterval.hasOwnProperty(removalKey)) {
      byInterval[removalKey] = [];
    }
    byInterval[removalKey].push({
      kind: removal.trackKind,
      index: removal.trackIndex,
      ripple: removal.ripple === true,
      key: removal.trackKind + removal.trackIndex
    });
  }
  for (var i = 0; i < plan.intervals.length; i++) {
    var interval = plan.intervals[i];
    var intervalKey = String(interval.startTicks) + '-' + String(interval.endTicks);
    var tracks = byInterval.hasOwnProperty(intervalKey) ? byInterval[intervalKey] : [];
    var edges = [String(interval.startTicks), String(interval.endTicks)];
    for (var e = 0; e < edges.length; e++) {
      if (!byTick.hasOwnProperty(edges[e])) {
        byTick[edges[e]] = {};
      }
      for (var t = 0; t < tracks.length; t++) {
        byTick[edges[e]][tracks[t].key] = tracks[t];
      }
    }
  }
  return {
    tracksOf: function (target) {
      var key = String(target.startTicks) + '-' + String(target.endTicks);
      return byInterval.hasOwnProperty(key) ? byInterval[key].slice(0) : [];
    },
    tracksAt: function (ticks) {
      return byTick.hasOwnProperty(String(ticks)) ? byTick[String(ticks)] : {};
    }
  };
}

/**
 * Collection position of every item per track, keyed by "start-end". Read once
 * after the razor pass. Removal runs from the end of the timeline towards the
 * start, so the positions of earlier items stay valid.
 */
function os_itemSlots(tracks) {
  var slots = {};
  for (var t = 0; t < tracks.length; t++) {
    var trackKey = tracks[t].kind + tracks[t].index;
    slots[trackKey] = {};
    for (var i = 0; i < tracks[t].items.length; i++) {
      var item = tracks[t].items[i];
      slots[trackKey][item.startTicks + '-' + item.endTicks] = i;
    }
  }
  return slots;
}

/** Item at the remembered slot when it still matches, otherwise a full scan. */
function os_itemAt(track, slot, interval) {
  if (typeof slot === 'number' && slot >= 0 && slot < track.clips.numItems) {
    var candidate = track.clips[slot];
    if (
      String(candidate.start.ticks) === String(interval.startTicks) &&
      String(candidate.end.ticks) === String(interval.endTicks)
    ) {
      return candidate;
    }
  }
  return os_findExactItem(track, interval);
}

/**
 * Moves for the shift assembly. Every item that starts at or after the end of a
 * removed interval moves left by the time removed up to that interval. Items
 * come back in timeline order, so a move always lands in space that is empty.
 */
function os_planShifts(tracks, intervals) {
  var shifts = [];
  for (var t = 0; t < tracks.length; t++) {
    var cursor = -1;
    var previous = null;
    for (var i = 0; i < tracks[t].items.length; i++) {
      var item = tracks[t].items[i];
      if (previous !== null && os_compareTicks(item.startTicks, previous) < 0) {
        throw new Error('Die Clips einer Spur sind nicht zeitlich sortiert.');
      }
      previous = item.startTicks;
      while (
        cursor + 1 < intervals.length &&
        os_compareTicks(String(intervals[cursor + 1].endTicks), item.startTicks) <= 0
      ) {
        cursor++;
      }
      if (cursor < 0) {
        continue;
      }
      shifts.push({
        key: tracks[t].kind + tracks[t].index,
        kind: tracks[t].kind,
        index: tracks[t].index,
        slot: i,
        startTicks: item.startTicks,
        offsetTicks: String(intervals[cursor].cumulativeRemovedTicks)
      });
    }
  }
  shifts.sort(function (first, second) {
    return os_compareTicks(first.startTicks, second.startTicks);
  });
  return shifts;
}

/**
 * Executes the planned moves. An item whose start already changed was moved
 * together with a linked partner and is skipped. The final readback in the
 * panel verifies every position.
 */
function os_applyShifts(sequence, shifts) {
  var moved = 0;
  for (var s = 0; s < shifts.length; s++) {
    var shift = shifts[s];
    var collection = shift.kind === 'video' ? sequence.videoTracks : sequence.audioTracks;
    var track = collection[shift.index];
    if (!track || shift.slot >= track.clips.numItems) {
      return { ok: false, moved: moved, error: 'Ein Clip auf ' + shift.key + ' fehlt vor dem Verschieben.' };
    }
    var clip = track.clips[shift.slot];
    if (String(clip.start.ticks) !== shift.startTicks) {
      continue;
    }
    var delta = new Time();
    delta.ticks = '-' + shift.offsetTicks;
    clip.move(delta);
    if (String(clip.start.ticks) === shift.startTicks) {
      return { ok: false, moved: moved, error: 'Ein Clip auf ' + shift.key + ' ließ sich nicht verschieben.' };
    }
    moved++;
  }
  return { ok: true, moved: moved };
}

/** Items of a plain track snapshot that overlap the interval. */
function os_coveringSnapshot(items, interval) {
  var result = [];
  for (var i = 0; i < items.length; i++) {
    if (
      os_compareTicks(items[i].startTicks, String(interval.endTicks)) < 0 &&
      os_compareTicks(items[i].endTicks, String(interval.startTicks)) > 0
    ) {
      result.push(items[i]);
    }
  }
  return result;
}

function os_findExactItem(track, interval) {
  var startTicks = String(interval.startTicks);
  var endTicks = String(interval.endTicks);
  var clips = track.clips;
  for (var index = 0; index < clips.numItems; index++) {
    var clip = clips[index];
    if (String(clip.start.ticks) === startTicks && String(clip.end.ticks) === endTicks) {
      return clip;
    }
  }
  return null;
}

/**
 * OS_applyPlan: verified, fail closed application on the clone.
 *
 * The payload carries the expected identities and fingerprints. Everything is
 * re-read inside this single synchronous call, before the first razor. The call
 * stops at the first unexpected result and never continues through a partial
 * state.
 */
function OS_applyPlan(payloadJson) {
  try {
    var payload = JSON.parse(payloadJson);
    var plan = payload.plan;
    if (!plan || !plan.intervals) {
      return os_fail('Kein gültiger Schnittplan.');
    }
    if (
      !payload.expectedOriginalId ||
      !payload.expectedCloneIdentity ||
      !payload.expectedOriginalFingerprint ||
      !payload.expectedCloneFingerprint
    ) {
      return os_fail('Der Auftrag hat keine vollständigen Kennungen und Fingerabdrücke. Es wird nichts geschnitten.');
    }
    var active = app.project.activeSequence;
    if (!active) {
      return os_fail('Keine aktive Sequenz.');
    }
    var activeIdentity = os_identity(active);
    if (!activeIdentity || activeIdentity !== payload.expectedCloneIdentity) {
      return os_fail('Die aktive Sequenz ist nicht die erwartete Kopie. Es wird nichts geschnitten.');
    }
    var original = os_findSequence(payload.expectedOriginalId);
    if (!original) {
      return os_fail('Die Originalsequenz wurde nicht gefunden.');
    }
    if (String(original.sequenceID) === String(active.sequenceID)) {
      return os_fail('Original und Ziel sind dieselbe Sequenz. Es wird nichts geschnitten.');
    }
    var originalItems = os_itemEnvelope(original);
    if (payload.expectedOriginalFingerprint !== originalItems) {
      return os_fail('Die Originalsequenz hat sich seit dem Lesen geändert. Es wird nichts geschnitten.');
    }
    var cloneItems = os_itemEnvelope(active);
    if (payload.expectedCloneFingerprint !== cloneItems) {
      return os_fail('Die Kopie hat sich seit dem Lesen geändert. Es wird nichts geschnitten.');
    }
    if (payload.expectedStateFingerprint && OS_readSequence() !== payload.expectedStateFingerprint) {
      return os_fail('Die Spuren oder Einstellungen haben sich vor dem Schnitt geändert.');
    }
    if (plan.intervals.length === 0) {
      return os_json({ ok: true, applied: 0, message: 'Keine Stillen zu schneiden.' });
    }

    app.enableQE();
    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence) {
      return os_fail('QE Zugriff nicht verfügbar, es wird nichts geschnitten.');
    }
    var frameRate = os_frameRate(active);
    if (!frameRate || !os_cutRateSupported(frameRate)) {
      return os_fail('Diese Bildrate ist nicht belegt, es wird nichts geschnitten.');
    }

    // Plan lookups built once: interval to tracks and razor tick to tracks.
    var planIndex = os_indexPlan(plan);
    // Shift assembly by default: lifts plus one move per item. 'ripple' keeps
    // the previous assembly with one ripple delete per pause.
    var useRipple = payload.assembly === 'ripple';

    function os_trackOf(kind, index) {
      var collection = kind === 'video' ? active.videoTracks : active.audioTracks;
      return collection[index];
    }

    // Preflight on the clone snapshot that was verified above. Plain data, no
    // host calls per interval.
    var cloneTracks = JSON.parse(cloneItems).tracks;
    function os_snapshotItems(kind, trackIndex) {
      for (var s = 0; s < cloneTracks.length; s++) {
        if (cloneTracks[s].kind === kind && cloneTracks[s].index === trackIndex) {
          return cloneTracks[s].items;
        }
      }
      return [];
    }

    // Preflight, per interval and per affected track: exactly one item that
    // fully contains the interval. A nearby item or a partial overlap is not
    // enough, the boundary has to lie inside the material.
    for (var preIndex = 0; preIndex < plan.intervals.length; preIndex++) {
      var interval = plan.intervals[preIndex];
      var tracks = planIndex.tracksOf(interval);
      var drivers = 0;
      for (var trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
        if (tracks[trackIndex].ripple) {
          drivers++;
        }
      }
      if (drivers !== 1) {
        return os_fail('Der Plan hat ' + drivers + ' Ripple Spuren für einen Bereich. Es wird nichts geschnitten.');
      }
      for (var checkIndex = 0; checkIndex < tracks.length; checkIndex++) {
        var covering = os_coveringSnapshot(
          os_snapshotItems(tracks[checkIndex].kind, tracks[checkIndex].index),
          interval
        );
        if (covering.length === 0) {
          return os_fail('Ein Bereich liegt auf ' + tracks[checkIndex].key + ' in keiner Passage.');
        }
        if (covering.length > 1) {
          return os_fail(
            'Ein Bereich liegt auf ' + tracks[checkIndex].key + ' über mehrere Clipstücke. Das ist nicht belegt.'
          );
        }
        if (
          os_compareTicks(String(covering[0].startTicks), String(interval.startTicks)) > 0 ||
          os_compareTicks(String(covering[0].endTicks), String(interval.endTicks)) < 0
        ) {
          return os_fail(
            'Ein Bereich reicht auf ' + tracks[checkIndex].key + ' über eine Lücke oder einen Cliprand hinaus.'
          );
        }
      }
    }

    // Razor every required track and boundary, deduplicated per track and tick.
    var razored = {};
    for (var pointIndex = 0; pointIndex < plan.razorPoints.length; pointIndex++) {
      var point = plan.razorPoints[pointIndex];
      var timecode;
      if (payload.nativeTimeline === true) {
        var nativeTime = new Time(); nativeTime.ticks = String(point.ticks);
        timecode = nativeTime.getFormatted(active.getSettings().videoFrameRate, active.videoDisplayFormat);
      } else {
        timecode = os_timecodeFromFrames(Number(point.frame), frameRate.fps);
      }
      if (!timecode) {
        return os_fail('Ein Schnittpunkt ist als Zeitcode nicht darstellbar.');
      }
      var needed = planIndex.tracksAt(point.ticks);
      for (var neededKey in needed) {
        if (!needed.hasOwnProperty(neededKey)) {
          continue;
        }
        var razorKey = neededKey + '@' + timecode;
        if (razored[razorKey]) {
          continue;
        }
        razored[razorKey] = true;
        var razorTrack = needed[neededKey];
        try {
          if (razorTrack.kind === 'video') {
            qeSequence.getVideoTrackAt(razorTrack.index).razor(timecode, true, true);
          } else {
            qeSequence.getAudioTrackAt(razorTrack.index).razor(timecode, true, true);
          }
        } catch (razorError) {
          return os_fail('Schnitt bei ' + timecode + ' fehlgeschlagen: ' + String(razorError));
        }
      }
    }

    var beforeRemovalTracks = os_readItemsOf(active);
    var slots = os_itemSlots(beforeRemovalTracks);
    if (payload.nativeTimeline === true) {
      var partitionProblem = os_validateNativePartitions(JSON.parse(cloneItems).tracks, beforeRemovalTracks);
      if (partitionProblem) return os_fail(partitionProblem);
      if (useRipple) {
        // One global ripple must move all writable tracks, regardless of the
        // user's original sync-lock selection.
        var syncKinds = ['video', 'audio'];
        for (var sk = 0; sk < syncKinds.length; sk++) {
          var syncCollection = syncKinds[sk] === 'video' ? active.videoTracks : active.audioTracks;
          for (var si = 0; si < syncCollection.numTracks; si++) {
            var syncTrack = syncKinds[sk] === 'video' ? qeSequence.getVideoTrackAt(si) : qeSequence.getAudioTrackAt(si);
            if (syncTrack.isLocked()) continue;
            syncTrack.setSyncLock(true);
            if (!syncTrack.isSyncLocked()) return os_fail('Sync Lock auf der Kopie konnte nicht aktiviert werden.');
          }
        }
      }
    }

    // Exact middle segment on every affected track, before any removal. This
    // also proves that no larger covering item would be deleted.
    for (var exactIndex = 0; exactIndex < plan.intervals.length; exactIndex++) {
      var exactInterval = plan.intervals[exactIndex];
      var exactTracks = planIndex.tracksOf(exactInterval);
      for (var exactTrackIndex = 0; exactTrackIndex < exactTracks.length; exactTrackIndex++) {
        var trackSlots = slots[exactTracks[exactTrackIndex].key];
        var exactKey = String(exactInterval.startTicks) + '-' + String(exactInterval.endTicks);
        if (!trackSlots || !trackSlots.hasOwnProperty(exactKey)) {
          return os_fail(
            'Nach dem Schnitt fehlt das exakte Mittelstück auf ' +
              exactTracks[exactTrackIndex].key +
              '. Es wird nichts entfernt.'
          );
        }
      }
    }

    if (!useRipple) {
      // A locked track that holds material after the first cut cannot follow
      // the shift. Stop before any lift.
      var firstEnd = String(plan.intervals[0].endTicks);
      for (var lockIndex = 0; lockIndex < beforeRemovalTracks.length; lockIndex++) {
        var lockTrack = beforeRemovalTracks[lockIndex];
        var qeLockTrack = lockTrack.kind === 'video' ? qeSequence.getVideoTrackAt(lockTrack.index) : qeSequence.getAudioTrackAt(lockTrack.index);
        if (!qeLockTrack.isLocked()) {
          continue;
        }
        for (var lockItem = 0; lockItem < lockTrack.items.length; lockItem++) {
          if (os_compareTicks(lockTrack.items[lockItem].startTicks, firstEnd) >= 0) {
            return os_fail('Eine gesperrte Spur müsste verschoben werden. Es wird nichts entfernt.');
          }
        }
      }
    }

    // Removal from the end towards the start. Ripple assembly: lifts first,
    // then the one ripple. Shift assembly: lifts only, the moves follow below.
    var intervals = plan.intervals.slice(0);
    intervals.sort(function (first, second) {
      return os_compareTicks(String(second.startTicks), String(first.startTicks));
    });
    var removed = 0;
    for (var orderIndex = 0; orderIndex < intervals.length; orderIndex++) {
      var current = intervals[orderIndex];
      var ordered = planIndex.tracksOf(current);
      ordered.sort(function (first, second) {
        return (first.ripple ? 1 : 0) - (second.ripple ? 1 : 0);
      });
      for (var removalOrder = 0; removalOrder < ordered.length; removalOrder++) {
        var task = ordered[removalOrder];
        var taskSlots = slots[task.key] || {};
        var item = os_itemAt(
          os_trackOf(task.kind, task.index),
          taskSlots[String(current.startTicks) + '-' + String(current.endTicks)],
          current
        );
        if (!item) {
          return os_fail('Das Mittelstück fehlt vor dem Entfernen. Abbruch nach ' + removed + ' Elementen.');
        }
        try {
          item.remove(useRipple && task.ripple === true, true);
          removed++;
        } catch (removeError) {
          return os_fail('Entfernen fehlgeschlagen: ' + String(removeError));
        }
      }
    }
    var moved = 0;
    if (!useRipple) {
      // Lifts changed the collections, so positions are read once more.
      var shifts = os_planShifts(os_readItemsOf(active), plan.intervals);
      var shiftResult = os_applyShifts(active, shifts);
      if (!shiftResult.ok) {
        return os_fail(
          shiftResult.error + ' Abbruch nach ' + removed + ' entfernten und ' + shiftResult.moved + ' verschobenen Elementen.'
        );
      }
      moved = shiftResult.moved;
    }
    return os_json({
      ok: true,
      removed: removed,
      moved: moved,
      applied: intervals.length,
      beforeRemovalTracks: payload.nativeTimeline === true ? beforeRemovalTracks : null,
      message: removed + ' Elemente entfernt, ' + intervals.length + ' Bereiche geschnitten.'
    });
  } catch (error) {
    return os_fail('Schnittplan konnte nicht angewendet werden: ' + String(error));
  }
}

function os_wavePreset() {
  try {
    var path = String(app.path).replace(/[\\\/]$/, '') + '/Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr';
    return new File(path).exists ? path : null;
  } catch (error) { return null; }
}

function os_cutRateSupported(rate) {
  return Math.abs(rate.fps - 25) < 1e-6 || (rate.numerator === 60000 && rate.denominator === 1001);
}

/** Render selected audible tracks on a native clone, restore active sequence. */
function OS_renderAudio(payloadJson) {
  var original = app.project.activeSequence;
  try {
    var payload = JSON.parse(payloadJson);
    if (!original || os_identity(original) !== payload.expectedIdentity ||
        os_itemEnvelope(original) !== payload.expectedItemFingerprint ||
        OS_readSequence() !== payload.expectedStateFingerprint) {
      return os_fail('Die Sequenz hat sich vor dem Audioexport geändert.');
    }
    var preset = os_wavePreset();
    if (!preset) return os_fail('Das mitgelieferte WAV-Preset wurde nicht gefunden.');
    var output = new File(payload.outputPath);
    if (output.exists || !output.parent.exists || !/\.wav$/i.test(output.fsName)) {
      return os_fail('Der Audioexport benötigt eine neue WAV-Datei in einem vorhandenen Ordner.');
    }
    var selected = {}, count = 0;
    for (var i = 0; i < payload.analysisTracks.length; i++) {
      var ref = payload.analysisTracks[i];
      if (ref.kind !== 'audio' || ref.index < 0 || ref.index >= original.audioTracks.numTracks || selected[ref.index]) {
        return os_fail('Die gewählten Analysespuren sind ungültig.');
      }
      var state = os_trackState(original, qe.project.getActiveSequence(), 'audio', ref.index);
      if (state.locked !== false || state.muted !== false) return os_fail('Eine Analysespur ist gesperrt oder stumm.');
      selected[ref.index] = true; count++;
    }
    if (!count) return os_fail('Keine Audiospur für den Export gewählt.');
    var clone = JSON.parse(OS_cloneSequence(payload.expectedIdentity, payload.expectedItemFingerprint));
    if (!clone.ok) return os_fail(clone.error);
    var copy = app.project.activeSequence;
    copy.name = String(original.name) + ' - Open Silences Analyse';
    var analysisBin = os_pluginBin('Open Silences Analysen');
    if (!analysisBin) return os_fail('Analyseordner konnte nicht angelegt werden.');
    copy.projectItem.moveBin(analysisBin);
    for (var t = 0; t < copy.audioTracks.numTracks; t++) {
      copy.audioTracks[t].setMute(selected[t] ? 0 : 1);
      if (Boolean(copy.audioTracks[t].isMuted()) !== !selected[t]) {
        return os_fail('Die Audiospuren der Analysekopie konnten nicht isoliert werden.');
      }
    }
    var started = new Date().getTime();
    var status = copy.exportAsMediaDirect(output.fsName, preset, 0);
    output = new File(payload.outputPath);
    if (!output.exists || output.length < 44) return os_fail('Premiere hat keine gültige Audiodatei exportiert: ' + String(status));
    if (os_itemEnvelope(original) !== payload.expectedItemFingerprint) return os_fail('Original während des Exports geändert.');
    return os_json({ok:true, mediaPath:output.fsName, analysisTracks:payload.analysisTracks,
      renderMilliseconds:new Date().getTime()-started, analysisSequenceId:copy.sequenceID, bytes:output.length});
  } catch (error) { return os_fail('Audioexport fehlgeschlagen: ' + String(error)); }
  finally { if (original) app.project.openSequence(original.sequenceID); }
}

/** Prove razor partitioning before deleting anything. No source-time guessing. */
function os_validateNativePartitions(original, split) {
  if (original.length !== split.length) return 'Spuranzahl nach dem Schnitt geändert.';
  for (var t = 0; t < original.length; t++) {
    if (original[t].kind !== split[t].kind || original[t].index !== split[t].index) return 'Spurzuordnung nach dem Schnitt geändert.';
    var used = 0;
    for (var i = 0; i < original[t].items.length; i++) {
      var item = original[t].items[i], cursor = item.startTicks, sourceCursor = item.sourceInTicks;
      for (var p = 0; p < split[t].items.length; p++) {
        var part = split[t].items[p];
        if (os_compareTicks(part.startTicks, item.startTicks) < 0 || os_compareTicks(part.endTicks, item.endTicks) > 0) continue;
        if (part.startTicks !== cursor || part.sourceInTicks !== sourceCursor ||
            part.mediaPath !== item.mediaPath || part.projectItemId !== item.projectItemId || part.disabled !== item.disabled ||
            os_compareTicks(part.endTicks, part.startTicks) <= 0) return 'Ein natives Schnittstück hat eine unerwartete Zuordnung.';
        cursor = part.endTicks; sourceCursor = part.sourceOutTicks; used++;
      }
      if (cursor !== item.endTicks || sourceCursor !== item.sourceOutTicks) return 'Der Schnitt bewahrt den vollständigen Quellbereich nicht.';
    }
    if (used !== split[t].items.length) return 'Zusätzliche Schnittstücke nach dem nativen Schnitt.';
  }
  return null;
}
