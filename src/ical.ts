
import fs from 'fs';

import axios from 'axios';

/* eslint-disable max-depth, max-params, no-warning-comments, complexity */

const { v4: uuid } = require('uuid');
const rrule = require('rrule').RRule;
import moment = require('moment-timezone');

function text(t = '') {
    return t
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\[nN]/g, '\n')
        .replace(/\\\\/g, '\\');
};

function parseValue(value: string) {
    if (value === 'TRUE') {
        return true;
    }

    if (value === 'FALSE') {
        return false;
    }

    const number = Number(value);
    if (!Number.isNaN(number)) {
        return number;
    }

    return value;
};

function parseParameters(p: any): any {
    const out: any = {};
    for (const element of p) {
        if (element.includes('=')) {
            const segs = element.split('=');

            out[segs[0]] = parseValue(segs.slice(1).join('='));
        }
    }
    return out;
};

function storeValueParameter(name: string | number) {
    return function (value: any, curr: { [x: string]: any[]; }) {
        const current = curr[name];

        if (Array.isArray(current)) {
            current.push(value);
            return curr;
        }

        if (typeof current === 'undefined') {
            curr[name] = value;
        } else {
            curr[name] = [current, value];
        }

        return curr;
    };
};

function storeParameter(name: string) {
    return function (value: string | undefined, parameters: string | any[], curr: any) {
        const data = parameters
            && parameters.length > 0
            && !(parameters.length === 1 && (parameters[0] === 'CHARSET=utf-8' || parameters[0] === 'VALUE=TEXT'))
            ? {
                params: parseParameters(parameters),
                val: text(value)
            }
            : text(value);

        return storeValueParameter(name)(data, curr);
    };
};

function addTZ(dt: any, parameters: any) {
    const p = parseParameters(parameters);

    if (dt.tz) {
        return dt;
    }

    if (parameters && p && dt) {
        dt.tz = p.TZID;
        if (dt.tz !== undefined) {
            // Remove surrouding quotes if found at the begining and at the end of the string
            // (Occurs when parsing Microsoft Exchange events containing TZID with Windows standard format instead IANA)
            dt.tz = dt.tz.replace(/^"(.*)"$/, '$1');
        }
    }

    return dt;
};

let zoneTable: { [x: string]: any; } | null = null;
function getIanaTZFromMS(msTZName: string | number) {
    if (!zoneTable) {
        const p = require('path');
        zoneTable = require(p.join(__dirname, 'windowsZones.json'));
    }

    // Get hash entry
    //@ts-ignore
    const he = zoneTable[msTZName];
    // If found return iana name, else null
    return he ? he.iana[0] : null;
}

function getTimeZone(value: any) {
    let tz = value;
    let found = '';
    // If this is the custom timezone from MS Outlook
    if (tz === 'tzone://Microsoft/Custom') {
        // Set it to the local timezone, cause we can't tell
        //@ts-ignore
        tz = moment.tz.guess();
    }

    // Remove quotes if found
    tz = tz.replace(/^"(.*)"$/, '$1');

    // Watch out for windows timezones
    if (tz && tz.includes(' ')) {
        const tz1 = getIanaTZFromMS(tz);
        if (tz1) {
            tz = tz1;
        }
    }

    // Watch out for offset timezones
    // If the conversion above didn't find any matching IANA tz
    // And offset is still present
    if (tz && tz.startsWith('(')) {
        // Extract just the offset
        const regex = /[+|-]\d*:\d*/;
        tz = null;
        found = tz.match(regex);
    }

    // Timezone not confirmed yet
    if (found === '') {
        // Lookup tz
        //@ts-ignore

        found = moment.tz.names().find((zone: any) => {
            return zone === tz;
        });
    }

    return found === '' ? tz : found;
}

function isDateOnly(value: string, parameters: string | string[]) {
    const dateOnly = ((parameters && parameters.includes('VALUE=DATE') && !parameters.includes('VALUE=DATE-TIME')) || /^\d{8}$/.test(value) === true);
    return dateOnly;
}

function typeParameter(name: string) {
    return function (value: any, parameters: any, curr: any) {
        const returnValue = isDateOnly(value, parameters) ? 'date' : 'date-time';
        return storeValueParameter(name)(returnValue, curr);
    };
};

function dateParameter(name: string) {
    return function (value: any, parameters: any, curr: any) {
        // The regex from main gets confued by extra :
        const pi = parameters.indexOf('TZID=tzone');
        if (pi >= 0) {
            // Correct the parameters with the part on the value
            parameters[pi] = parameters[pi] + ':' + value.split(':')[0];
            // Get the date from the field, other code uses the value parameter
            value = value.split(':')[1];
        }

        let newDate: any = text(value);

        // Process 'VALUE=DATE' and EXDATE
        if (isDateOnly(value, parameters)) {
            // Just Date
            const comps = /^(\d{4})(\d{2})(\d{2}).*$/.exec(value);
            if (comps !== null) {
                // No TZ info - assume same timezone as this computer
                //@ts-ignore

                newDate = new Date(comps[1], Number.parseInt(comps[2], 10) - 1, comps[3]);

                newDate.dateOnly = true;

                // Store as string - worst case scenario
                return storeValueParameter(name)(newDate, curr);
            }
        }

        // Typical RFC date-time format
        const comps = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
        if (comps !== null) {
            if (comps[7] === 'Z') {
                // GMT
                newDate = new Date(
                    Date.UTC(
                        Number.parseInt(comps[1], 10),
                        Number.parseInt(comps[2], 10) - 1,
                        Number.parseInt(comps[3], 10),
                        Number.parseInt(comps[4], 10),
                        Number.parseInt(comps[5], 10),
                        Number.parseInt(comps[6], 10)
                    )
                );
                newDate.tz = 'Etc/UTC';
            } else if (parameters && parameters[0] && parameters[0].includes('TZID=') && parameters[0].split('=')[1]) {
                // Get the timeozone from trhe parameters TZID value
                let tz = parameters[0].split('=')[1];
                let found = '';
                let offset = '';

                // If this is the custom timezone from MS Outlook
                if (tz === 'tzone://Microsoft/Custom') {
                    // Set it to the local timezone, cause we can't tell
                    //@ts-ignore

                    tz = moment.tz.guess();
                    parameters[0] = 'TZID=' + tz;
                }

                // Remove quotes if found
                tz = tz.replace(/^"(.*)"$/, '$1');

                // Watch out for windows timezones
                if (tz && tz.includes(' ')) {
                    const tz1 = getIanaTZFromMS(tz);
                    if (tz1) {
                        tz = tz1;
                        // We have a confirmed timezone, dont use offset, may confuse DST/STD time
                        offset = '';
                    }
                }

                // Watch out for offset timezones
                // If the conversion above didn't find any matching IANA tz
                // And oiffset is still present
                if (tz && tz.startsWith('(')) {
                    // Extract just the offset
                    const regex = /[+|-]\d*:\d*/;
                    offset = tz.match(regex);
                    tz = null;
                    found = offset;
                }

                // Timezone not confirmed yet
                if (found === '') {
                    // Lookup tz
                    //@ts-ignore

                    found = moment.tz.names().find((zone: any) => {
                        return zone === tz;
                    });
                }

                // Timezone confirmed or forced to offset
                //@ts-ignore

                newDate = found ? moment.tz(value, 'YYYYMMDDTHHmmss' + offset, tz).toDate() : new Date(
                    Number.parseInt(comps[1], 10),
                    Number.parseInt(comps[2], 10) - 1,
                    Number.parseInt(comps[3], 10),
                    Number.parseInt(comps[4], 10),
                    Number.parseInt(comps[5], 10),
                    Number.parseInt(comps[6], 10)
                );

                newDate = addTZ(newDate, parameters);
            } else {
                newDate = new Date(
                    Number.parseInt(comps[1], 10),
                    Number.parseInt(comps[2], 10) - 1,
                    Number.parseInt(comps[3], 10),
                    Number.parseInt(comps[4], 10),
                    Number.parseInt(comps[5], 10),
                    Number.parseInt(comps[6], 10)
                );
            }
        }

        // Store as string - worst case scenario
        return storeValueParameter(name)(newDate, curr);
    };
};

function geoParameter(name: string) {
    return function (value: string, parameters: any, curr: { [x: string]: { lat: number; lon: number; }; }) {
        //@ts-ignore

        storeParameter(value, parameters, curr);
        const parts = value.split(';');
        curr[name] = { lat: Number(parts[0]), lon: Number(parts[1]) };
        return curr;
    };
};

function categoriesParameter(name: string) {
    const separatorPattern = /\s*,\s*/g;
    return function (value: string, parameters: any, curr: { [x: string]: string | any[]; }) {
        //@ts-ignore

        storeParameter(value, parameters, curr);
        if (curr[name] === undefined) {
            curr[name] = value ? value.split(separatorPattern) : [];
        } else if (value) {
            //@ts-ignore

            curr[name] = curr[name].concat(value.split(separatorPattern));
        }

        return curr;
    };
};

// EXDATE is an entry that represents exceptions to a recurrence rule (ex: "repeat every day except on 7/4").
// The EXDATE entry itself can also contain a comma-separated list, so we make sure to parse each date out separately.
// There can also be more than one EXDATE entries in a calendar record.
// Since there can be multiple dates, we create an array of them.  The index into the array is the ISO string of the date itself, for ease of use.
// i.e. You can check if ((curr.exdate != undefined) && (curr.exdate[date iso string] != undefined)) to see if a date is an exception.
// NOTE: This specifically uses date only, and not time.  This is to avoid a few problems:
//    1. The ISO string with time wouldn't work for "floating dates" (dates without timezones).
//       ex: "20171225T060000" - this is supposed to mean 6 AM in whatever timezone you're currently in
//    2. Daylight savings time potentially affects the time you would need to look up
//    3. Some EXDATE entries in the wild seem to have times different from the recurrence rule, but are still excluded by calendar programs.  Not sure how or why.
//       These would fail any sort of sane time lookup, because the time literally doesn't match the event.  So we'll ignore time and just use date.
//       ex: DTSTART:20170814T140000Z
//             RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO,TU
//             EXDATE:20171219T060000
//       Even though "T060000" doesn't match or overlap "T1400000Z", it's still supposed to be excluded?  Odd. :(
// TODO: See if this causes any problems with events that recur multiple times a day.
function exdateParameter(name: string) {
    return function (value: string, parameters: any, curr: { [x: string]: { [x: string]: any; }; }) {
        const separatorPattern = /\s*,\s*/g;
        curr[name] = curr[name] || [];
        const dates = value ? value.split(separatorPattern) : [];
        for (const entry of dates) {
            const exdate: never[] = [];
            dateParameter(name)(entry, parameters, exdate);

            if (exdate[name as any]) {
                //@ts-ignore
                if (typeof exdate[name as any].toISOString === 'function') {
                    //@ts-ignore
                    curr[name][exdate[name as any].toISOString().slice(0, 10)] = exdate[name as any];
                } else {
                    throw new TypeError('No toISOString function in exdate[name]' + exdate[name as any]);
                }
            }
        }

        return curr;
    };
};

// RECURRENCE-ID is the ID of a specific recurrence within a recurrence rule.
// TODO:  It's also possible for it to have a range, like "THISANDPRIOR", "THISANDFUTURE".  This isn't currently handled.
function recurrenceParameter(name: string) {
    return dateParameter(name);
};

function addFBType(fb: { type?: any; }, parameters: any) {
    const p = parseParameters(parameters);

    if (parameters && p) {
        fb.type = p.FBTYPE || 'BUSY';
    }

    return fb;
};

function freebusyParameter(name: string) {
    return function (value: string, parameters: any, curr: { [x: string]: any[]; }) {
        const fb = addFBType({}, parameters);
        curr[name] = curr[name] || [];
        curr[name].push(fb);
        //@ts-ignore

        storeParameter(value, parameters, fb);

        const parts = value.split('/');

        for (const [index, name] of ['start', 'end'].entries()) {
            dateParameter(name)(parts[index], parameters, fb);
        }

        return curr;
    };
};

function getLineBreakChar(string: string | string[]) {
    const indexOfLF = string.indexOf('\n', 1); // No need to check first-character
    if (indexOfLF === -1) {
        if (string.includes('\r')) {
            return '\r';
        }
        return '\n';
    }
    if (string[indexOfLF - 1] === '\r') {
        return '\r?\n';
    }
    return '\n';
}

const objectHandlers: any = {
    BEGIN(component: any, parameters: any, curr: any, stack: any[]) {
        stack.push(curr);

        return { type: component, params: parameters };
    },
    END(value: string, parameters: any, curr: { rrule: string; start: any; }, stack: any) {
        // Original end function
        //@ts-ignore
        function originalEnd(component: string, parameters_: any, curr: { [x: string]: any; end: Date; datetype: string; start: any; duration: string | undefined; uid: string | number; recurrenceid: { toISOString: () => string; } | undefined; }, stack: any[]) {
            // Prevents the need to search the root of the tree for the VCALENDAR object
            if (component === 'VCALENDAR') {
                // Scan all high level object in curr and drop all strings
                let key;
                let object;

                for (key in curr) {
                    if (!{}.hasOwnProperty.call(curr, key)) {
                        continue;
                    }

                    object = curr[key];
                    if (typeof object === 'string') {
                        delete curr[key];
                    }
                }

                return curr;
            }

            const par = stack.pop();

            if (!curr.end) { // RFC5545, 3.6.1
                if (curr.datetype === 'date-time') {
                    curr.end = curr.start;
                    // If the duration is not set
                } else if (curr.duration === undefined) {
                    // Set the end to the start plus one day RFC5545, 3.6.1
                    curr.end = moment.utc(curr.start).add(1, 'days').toDate(); // New Date(moment(curr.start).add(1, 'days'));
                } else {
                    const durationUnits =
                    {
                        // Y: 'years',
                        // M: 'months',
                        W: 'weeks',
                        D: 'days',
                        H: 'hours',
                        M: 'minutes',
                        S: 'seconds'
                    };
                    // Get the list of duration elements
                    const r = curr.duration.match(/-?\d+[YMWDHS]/g);
                    let newend = moment.utc(curr.start);
                    // Is the 1st character a negative sign?
                    const indicator = curr.duration.startsWith('-') ? -1 : 1;
                    // Process each element
                    if (r)
                        for (const d of r) {
                            //@ts-ignore

                            newend = newend.add(Number.parseInt(d, 10) * indicator, durationUnits[d.slice(-1)]);
                        }

                    curr.end = newend.toDate();
                }
            }

            if (curr.uid) {
                // If this is the first time we run into this UID, just save it.
                if (par[curr.uid] === undefined) {
                    par[curr.uid] = curr;

                    if (par.method) { // RFC5545, 3.2
                        par[curr.uid].method = par.method;
                    }
                } else if (curr.recurrenceid === undefined) {
                    // If we have multiple ical entries with the same UID, it's either going to be a
                    // modification to a recurrence (RECURRENCE-ID), and/or a significant modification
                    // to the entry (SEQUENCE).

                    // TODO: Look into proper sequence logic.

                    // If we have the same UID as an existing record, and it *isn't* a specific recurrence ID,
                    // not quite sure what the correct behaviour should be.  For now, just take the new information
                    // and merge it with the old record by overwriting only the fields that appear in the new record.
                    let key;
                    for (key in curr) {
                        if (key !== null) {
                            par[curr.uid][key] = curr[key];
                        }
                    }
                }

                // If we have recurrence-id entries, list them as an array of recurrences keyed off of recurrence-id.
                // To use - as you're running through the dates of an rrule, you can try looking it up in the recurrences
                // array.  If it exists, then use the data from the calendar object in the recurrence instead of the parent
                // for that day.

                // NOTE:  Sometimes the RECURRENCE-ID record will show up *before* the record with the RRULE entry.  In that
                // case, what happens is that the RECURRENCE-ID record ends up becoming both the parent record and an entry
                // in the recurrences array, and then when we process the RRULE entry later it overwrites the appropriate
                // fields in the parent record.

                if (typeof curr.recurrenceid !== 'undefined') {
                    // TODO:  Is there ever a case where we have to worry about overwriting an existing entry here?

                    // Create a copy of the current object to save in our recurrences array.  (We *could* just do par = curr,
                    // except for the case that we get the RECURRENCE-ID record before the RRULE record.  In that case, we
                    // would end up with a shared reference that would cause us to overwrite *both* records at the point
                    // that we try and fix up the parent record.)
                    const recurrenceObject: any = {};
                    let key;
                    for (key in curr) {
                        if (key !== null) {
                            recurrenceObject[key] = curr[key];
                        }
                    }

                    if (typeof recurrenceObject.recurrences !== 'undefined') {
                        delete recurrenceObject.recurrences;
                    }

                    // If we don't have an array to store recurrences in yet, create it.
                    if (par[curr.uid].recurrences === undefined) {
                        par[curr.uid].recurrences = {};
                    }

                    // Save off our cloned recurrence object into the array, keyed by date but not time.
                    // We key by date only to avoid timezone and "floating time" problems (where the time isn't associated with a timezone).
                    // TODO: See if this causes a problem with events that have multiple recurrences per day.
                    if (typeof curr.recurrenceid.toISOString === 'function') {
                        par[curr.uid].recurrences[curr.recurrenceid.toISOString().slice(0, 10)] = recurrenceObject;
                    } else { // Removed issue 56
                        throw new TypeError('No toISOString function in curr.recurrenceid' + curr.recurrenceid);
                    }
                }

                // One more specific fix - in the case that an RRULE entry shows up after a RECURRENCE-ID entry,
                // let's make sure to clear the recurrenceid off the parent field.
                if (typeof par[curr.uid].rrule !== 'undefined' && typeof par[curr.uid].recurrenceid !== 'undefined') {
                    delete par[curr.uid].recurrenceid;
                }
            } else {
                const id = uuid();
                par[id] = curr;

                if (par.method) { // RFC5545, 3.2
                    par[id].method = par.method;
                }
            }

            return par;
        };

        // Recurrence rules are only valid for VEVENT, VTODO, and VJOURNAL.
        // More specifically, we need to filter the VCALENDAR type because we might end up with a defined rrule
        // due to the subtypes.

        if ((value === 'VEVENT' || value === 'VTODO' || value === 'VJOURNAL') && curr.rrule) {
            let rule = curr.rrule.replace('RRULE:', '');
            // Make sure the rrule starts with FREQ=
            rule = rule.slice(rule.lastIndexOf('FREQ='));
            // If no rule start date
            if (rule.includes('DTSTART') === false) {
                // Get date/time into a specific format for comapare
                let x = moment(curr.start).format('MMMM/Do/YYYY, h:mm:ss a');
                // If the local time value is midnight
                // This a whole day event
                if (x.slice(-11) === '12:00:00 am') {
                    // Get the timezone offset
                    // The internal date is stored in UTC format
                    const offset = curr.start.getTimezoneOffset();
                    // Only east of gmt is a problem
                    if (offset < 0) {
                        // Calculate the new startdate with the offset applied, bypass RRULE/Luxon confusion
                        // Make the internally stored DATE the actual date (not UTC offseted)
                        // Luxon expects local time, not utc, so gets start date wrong if not adjusted
                        //curr.start = new Date(curr.start.getTime() + (Math.abs(offset) * 60000));
                    } else {
                        // Get rid of any time (shouldn't be any, but be sure)
                        x = moment(curr.start).format('MMMM/Do/YYYY');
                        const comps = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(x);
                        if (comps) {
                            //@ts-ignore

                            curr.start = new Date(comps[3], comps[1] - 1, comps[2]);
                        }
                    }
                }

                // If the date has an toISOString function
                if (curr.start && typeof curr.start.toISOString === 'function') {
                    try {
                        // If the original date has a TZID, add it
                        if (curr.start.tz) {
                            const tz = getTimeZone(curr.start.tz);
                            rule += `;DTSTART;TZID=${tz}:${curr.start.toISOString().replace(/[-:]/g, '')}`;
                        } else {
                            rule += `;DTSTART=${curr.start.toISOString().replace(/[-:]/g, '')}`;
                        }

                        rule = rule.replace(/\.\d{3}/, '');
                    } catch (error) { // This should not happen, issue #56
                        throw new Error('ERROR when trying to convert to ISOString' + error);
                    }
                } else {
                    throw new Error('No toISOString function in curr.start' + curr.start);
                }
            }

            // Make sure to catch error from rrule.fromString()
            try {
                curr.rrule = rrule.fromString(rule);
            } catch (error) {
                throw error;
            }
        }
        //@ts-ignore

        return originalEnd.call(this, value, parameters, curr, stack);
    },
    SUMMARY: storeParameter('summary'),
    DESCRIPTION: storeParameter('description'),
    URL: storeParameter('url'),
    UID: storeParameter('uid'),
    LOCATION: storeParameter('location'),
    DTSTART(value: any, parameters: any, curr: any) {
        curr = dateParameter('start')(value, parameters, curr);
        return typeParameter('datetype')(value, parameters, curr);
    },
    DTEND: dateParameter('end'),
    EXDATE: exdateParameter('exdate'),
    ' CLASS': storeParameter('class'), // Should there be a space in this property?
    TRANSP: storeParameter('transparency'),
    GEO: geoParameter('geo'),
    'PERCENT-COMPLETE': storeParameter('completion'),
    COMPLETED: dateParameter('completed'),
    CATEGORIES: categoriesParameter('categories'),
    FREEBUSY: freebusyParameter('freebusy'),
    DTSTAMP: dateParameter('dtstamp'),
    CREATED: dateParameter('created'),
    'LAST-MODIFIED': dateParameter('lastmodified'),
    'RECURRENCE-ID': recurrenceParameter('recurrenceid'),
    //@ts-ignore
    RRULE(value: any, parameters: any, curr: { rrule: any; }, stack: any, line: any) {
        curr.rrule = line;
        return curr;
    }
}

export function handleObject(name: string, value: any, parameters: any, ctx: any, stack: string | any[], line: any) {
    if (objectHandlers[name]) {
        return objectHandlers[name](value, parameters, ctx, stack, line);
    }

    // Handling custom properties
    if (/X-[\w-]+/.test(name) && stack.length > 0) {
        // Trimming the leading and perform storeParam
        name = name.slice(2);
        //@ts-ignore

        return storeParameter(name)(value, parameters, ctx, stack, line);
    }

    return storeParameter(name.toLowerCase())(value, parameters, ctx);
}

export function parseLines(lines: string | any[], limit: number, ctx?: { type?: any; params?: any; } | undefined, stack?: never[], lastIndex?: number, cb?: (arg0: null, arg1: any) => void) {
    if (!cb && typeof ctx === 'function') {
        cb = ctx;
        ctx = undefined;
    }

    ctx = ctx || {};
    stack = stack || [];

    let limitCounter = 0;

    let i = lastIndex || 0;
    for (let ii = lines.length; i < ii; i++) {
        let l = lines[i];
        // Unfold : RFC#3.1
        while (lines[i + 1] && /[ \t]/.test(lines[i + 1][0])) {
            l += lines[i + 1].slice(1);
            i++;
        }

        // Remove any double quotes in any tzid statement// except around (utc+hh:mm
        if (l.includes('TZID=') && !l.includes('"(')) {
            l = l.replace(/"/g, '');
        }

        const exp = /^([\w\d-]+)((?:;[\w\d-]+=(?:(?:"[^"]*")|[^":;]+))*):(.*)$/;
        let kv = l.match(exp);

        if (kv === null) {
            // Invalid line - must have k&v
            continue;
        }

        kv = kv.slice(1);

        const value = kv[kv.length - 1];
        const name = kv[0];
        const parameters = kv[1] ? kv[1].split(';').slice(1) : [];

        ctx = handleObject(name, value, parameters, ctx, stack, l) || {};
        if (++limitCounter > limit) {
            break;
        }
    }

    if (i >= lines.length) {
        // Type and params are added to the list of items, get rid of them.
        delete ctx?.type;
        delete ctx?.params;
    }

    if (cb) {
        if (i < lines.length) {
            setImmediate(() => {
                parseLines(lines, limit, ctx, stack, i + 1, cb);
            });
        } else {
            setImmediate(() => {
                cb!(null, ctx);
            });
        }
    } else {
        return ctx;
    }
    return null;
}

export function parseICS(string: string) :any{
    const lineEndType = getLineBreakChar(string);
    const lines = string.split(lineEndType === '\n' ? /\n/ : /\r?\n/);
    let ctx = parseLines(lines, lines.length);
    return ctx;
}

export async function fromURL(url: any, options: any) {
    const response = await axios.get(url, options)
    if (Math.floor(response.status / 100) !== 2) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return parseICS(response.data);
}

export async function parseFile(filename: any) {
    const data = await fs.promises.readFile(filename, 'utf8')
    return parseICS(data)
}