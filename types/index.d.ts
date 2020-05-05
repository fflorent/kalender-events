import { Config } from './config';
import { IKalenderEvent, iCalEvent } from './event';

/** Declaration file generated by dts-gen */

export class KalenderEvents {
    constructor(config: Config);
    convertEvent(event: iCalEvent): IKalenderEvent;
    convertEvents(events: any): any;
    countdown(date: Date): any;      
    getEvents(config?: Config): Promise<IKalenderEvent[]>;
}

