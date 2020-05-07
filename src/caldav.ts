import { Config } from 'config';

import dav = require('dav');
import Scrapegoat = require("scrapegoat");
import moment = require('moment');
import IcalExpander = require('ical-expander');
import * as  ical from 'node-ical';
import { KalenderEvents } from './lib';
import { iCalEvent, IKalenderEvent } from 'event';
var debug = require('debug')('kalendar-events')

export async function CalDav(config: Config): Promise<IKalenderEvent[]> {
    const calName = config.calendar;
    const ke = new KalenderEvents(config);
    const now = moment();
    const whenMoment = moment(now.toDate());

    // @ts-ignore
    let start = whenMoment.clone().startOf('day').subtract(config.pastview, config.pastviewUnits);
    // @ts-ignore
    let end = whenMoment.clone().endOf('day').add(config.preview, config.previewUnits);

    if (config.pastviewUnits === 'days') {
        start = whenMoment.clone().startOf('day').subtract(config.pastview + 1, 'days');
    }
    if (config.previewUnits === 'days') {
        end = whenMoment.clone().endOf('day').add(config.preview, 'days');
    }
    const filters = [{
        type: 'comp-filter',
        attrs: { name: 'VCALENDAR' },
        children: [{
            type: 'comp-filter',
            attrs: { name: 'VEVENT' },
            children: [{
                type: 'time-range',
                attrs: {
                    start: start.format('YYYYMMDD[T]HHmmss[Z]'),
                    end: end.format('YYYYMMDD[T]HHmmss[Z]'),
                },
            }],
        }],
    }];

    const xhr = new dav.transport.Basic(
        new dav.Credentials({
            username: config.username,
            password: config.password,
        }),
    );

    let calDavUri = config.url;
    let url = new URL(calDavUri);
    const account = await dav.createAccount({ server: calDavUri, xhr: xhr, loadCollections: true, loadObjects: true })

    let promises: Promise<Promise<IKalenderEvent>>[] = [];
    if (!account.calendars) {
        throw 'CalDAV -> no calendars found.';
    }
    let retEntries: IKalenderEvent[] = [];
    for (let calendar of account.calendars) {

        if (!calName || !calName.length || (calName && calName.length && calName.toLowerCase() === calendar.displayName.toLowerCase())) {
            //@ts-ignore
            let calendarEntries = await dav.listCalendarObjects(calendar, { xhr: xhr, filters: filters })
            for (let calendarEntry of calendarEntries) {
                const ics = calendarEntry.calendarData;
                if (ics) {
                    const icalExpander = new IcalExpander({ ics, maxIterations: 100 });
                    const events = icalExpander.between(start.toDate(), end.toDate());

                    ke.convertEvents(events).forEach((event: IKalenderEvent) => {
                        debug(`caldav - ical: ${JSON.stringify(event)}`)
                        if (event) {
                            event.calendarName = calendar.displayName;
                            retEntries.push(event);
                        }
                    });
                }
            }

            //@ts-ignore
            calendarEntries = await dav.listCalendarObjects(calendar, { xhr: xhr, filters: filters })
            for (let calendarEntry of calendarEntries) {
                if (calendarEntry.calendar.objects) {
                    for (let calendarObject of calendarEntry.calendar.objects) {
                        if (calendarObject.data && calendarObject.data.href) {
                            let ics = url.origin + calendarObject.data.href;
                            let header = {};
                            let username = config.username;
                            let password = config.password;
                            if (username && password) {
                                var auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
                                header = {
                                    headers: {
                                        'Authorization': auth,
                                    },
                                };
                            }
                           
                            const data = await ical.async.fromURL(ics, header);
                            for (var k in data) {
                                //debug(`caldav - href: ${JSON.stringify(data[k])}`)
                                var ev = ke.convertEvent(data[k]);
                                if (ev) {
                                    ev.calendarName = calendar.displayName;                                    
                                    retEntries.push(ev);
                                }
                            }

                        }
                    }
                }
            }

        }
    }
    return retEntries;

}

export async function Fallback(config: Config) {
    const ke = new KalenderEvents(config);
    let scrapegoat = new Scrapegoat({
        auth: {
            user: config.username,
            pass: config.password
        },
        uri: config.url,
        rejectUnauthorized: config.rejectUnauthorized
    });

    let data = await scrapegoat.getAllEvents();

    return ke.convertEvents(data);
}