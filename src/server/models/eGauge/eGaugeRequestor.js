/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const axios = require('axios');
const crypto = require('crypto');
const { log } = require('../../log');
const md5 = require('md5');
const moment = require('moment-timezone');
const Meter = require('../Meter');
const { meterTimezone } = require('../../services/meterTimezone');

class EgaugeRequestor {

	/**
	 * Create object for reading an eGauge meter. The meter.url is expected to have these elements
	 * where this specifies the key and value comes next after an equal (=) sign:
	 * - username or email to specify the login name for the eGauge meter.
	 * - password to specify the login password for the eGauge meter and the login name specified.
	 * - registerName to tell the name of the register desired from the eGauge meter.
	 * 
	 * The start of the url will have the web address for getting the meter data. An example for a physical register where < > items are replaced with real values is
	 * ```egauge<####>.egaug.es/api?registerName=<register>&username=<name>&password=<pass>```
	 * @param {Meter} meter associated with the eGauge readings.
	 */
	constructor(meter) {
		// Information expected by the eGauge API and needed by OED.
		const url = new URL(`https://${meter.url}`);
		this.apiUrl = `${url.origin}/api`;
		// TODO:
		// Allowing for backwards compatibility if previous eGauge meters are using the 'email' parameter instead of
		// the 'username' parameter to login. Developers need to decide in the future if we should deprecate email
		// or continue to allow this backwards compatibility
		const username = url.searchParams.get('username') || url.searchParams.get('email');
		this.username = username;
		this.password = url.searchParams.get('password');
		this.registerName = url.searchParams.get('registerName');
		this.meter = meter;
		this.jwt = undefined;
		this.registerId = undefined;
		this.requestHeaders = undefined;
	}

	/**
	 * Login to the eGauge device via the provided url on the meter.
	 * @post this.jwt is set to a valid jwt obtained from the eGauge device.
	 * @returns jwt
	 */
	async login() {
		// Perform login via digest protocol as documented in eGauge JSON web api.
		const authUrl = `${this.apiUrl}/auth/`;
		const loginUrl = authUrl + 'login';
		let rlm;
		let nnc;
		try {
			await axios.get(authUrl);
			// the request is expected to fail and supply the realm and nnc
		} catch (error) {
			({ rlm, nnc } = (error.response.data));
		}

		const USERNAME = this.username;
		const PASSWORD = this.password;

		// This use of MD5 is specified in the eGauge api.
		const CNONCE = crypto.randomBytes(64).toString('hex');
		const HA1 = md5(`${USERNAME}:${rlm}:${PASSWORD}`);
		const HA2 = md5(`${HA1}:${nnc}:${CNONCE}`);

		const res = await axios.post(loginUrl, {
			'rlm': rlm,
			'usr': USERNAME,
			'nnc': nnc,
			'cnnc': CNONCE,
			'hash': HA2
		});

		const { jwt } = res.data;
		this.jwt = jwt;
		this.requestHeaders = { Authorization: `Bearer ${jwt}` };
		return jwt;
	}

	/**
	 * Fetches eGauge data within a time interval. If the reading unit is detected to be Power (recorded as W*s), we convert it kWh.
	 * @param {number | string} startTimestamp unix start timestamp or 'epoch' which is an eGauge keyword for when the device began gathering data.
	 * @param {number | string} endTimestamp unix end timestamp or 'soh' which is an eGauge keyword for the start of the current hour.
	 * @param {number} timeStep time step between readings in seconds.
	 * @param {string} timezoneUse timezone to interpret the readings in since eGauge uses Unix timestamps that depend on the timezone.
	 * @returns {Promise<[[number, moment, moment]]>} a matrix whose rows consists of the reading value and the end timestamp as a moment. Empty if an error occurs.
	 */
	async getMeterReadingsBetweenInterval(startTimestamp, endTimestamp, timeStep, timezoneUse) {
		// Will hold readings from this request.
		let meterReadings = [];
		try {
			// Get data (readings) from this eGauge device.
			// These are the parts of the request:
			// /register To get register based information.
			// virtual=value Unsure exact meaning but without it you don't get the desired information.
			// reg=this.registerId This get information on the specific register with that ID.
			// format=json This returns information as JSON.
			// time=${startTimestamp}:${timeStep}:${endTimestamp} specifies the start time, step between readings and end time for readings.
			const res = await this.get(`${this.apiUrl}/register/?virtual=value&reg=${this.registerId}&rate&format=json&time=${startTimestamp}:${timeStep}:${endTimestamp}`);
			const data = res.data;
			if (data.error === undefined) {
				// No error so process as usual.
				// Could check if data for registers and/or ranges was not length 1 but unclear how that can happen.

				// What type of reading data was sent. Asked for a single registerId so there should only be one response.
				const readingType = data.registers[0].type;
				// Make sure of type P for now. P should be in watts or J/sec.
				// TODO We also need to deal with other unit types.
				if (readingType !== 'P') {
					throw new Error(`The meter type is ${readingType} but must be P for OED to process eGauge readings at this time.`);
				}
				// The code used to loop over data.ranges. However, as noted with type, it is assumed that only one
				// set of data for a single register will be returned. If not, something is wrong and looping will
				// probably lead to adding data from multiple registers and not what desired (as for as is known).
				// Thus, the code uses index 0 instead of looping.
				// The readings sent.
				const dataRange = data.ranges[0];
				const delta = dataRange.delta;
				const readingValues = dataRange.rows;
				// TODO What was the 's' parameter for? Removed it and it still works.
				const endTs = moment.unix(dataRange.ts).tz(timezoneUse);
				// timeDelta is in seconds which is time between readings.
				const timeDelta = dataRange.delta;
				// Loop over all readings.
				for (let i = 0; i < readingValues.length; i++) {
					// eGauge sends data that is relative to the dataRange.ts where each
					// point is one more timeDelta back in time.
					// Need to create a new moment since these function mutate.
					const startTime = endTs.clone().subtract(timeDelta * (i + 1), 's');
					// The end time is just a shift of the time of each reading in seconds byt the time between readings.
					const endTime = startTime.clone().add(timeDelta, 's');
					// This is the reading value which is an integer.
					let val = parseInt(readingValues[i][0]);
					// if unit is P then we know that the upload data is in W*s so we convert to kWh; otherwise, we don't convert.
					// TODO In the future with units maybe we should use the raw meter value and have it converted when graphing. We also need to deal with other unit types.
					// Per check above, this assumes the type is P.
					// A P type is believed to return watts (J/sec). Multiply to by length of time for this reading that is
					// delta which is in seconds. This gets J and the conversion to kWh is 1 kWh = 3.6e+6 J. Overall this is
					// val * delta / 3.6e+6.
					val = val * delta / (1000 * 3600);
					meterReadings.push([val, startTime, endTime]);
				}
			} else {
				// An error can occur if the time range is improper. For example, if the endTimestamp is
				// after the startTimestamp. In this case no readings are recorded.
				// meterReadings will remain empty in this case.
				log.error(`No data received/stored in getting eGauge readings for meter "${this.meter}"` +
					`for register "this.registerName" so no readings returned and due to error: ${data.error}`);
			}

		} catch (err) {
			log.error(`An unexpected error occurred while getting eGauge readings for meter "${this.meter}"` +
				`for register "this.registerName" so no readings returned and due to error: `, err);
			// Empty readings in case some were put in.
			meterReadings = [];
		}

		// Either the readings or empty if error occurred.
		return meterReadings;
	}

	/**
	 * Fetches the next hour of eGauge data for this.meter if fetched the last hour. Otherwise, it fetches
	 * data back to the last time fetched or all time if never fetched before.
	 * @returns {Promise<[[number, moment]]>} a matrix whose rows consists of the reading value and the end timestamp as a moment.
	 */
	async getMeterReadings() {
		// The meter endTimestamp is stored as a string so we need to parse and then convert to UTC.
		const endTimestampTz = moment.parseZone(this.meter.endTimestamp, true);
		// Note this modifies the endTimestampTz object.
		const lastTimestamp = moment.parseZone(endTimestampTz.tz('UTC', true));
		let startTimestamp;
		// The timezone we interpret the readings in.
		const timezoneUse = await meterTimezone(this.meter);
		// Using 'soh' for the endTimestamp allows us to cover the case where
		// we miss a batch(es) of readings, for example if the OED web server goes down.
		// 'soh' will instruct eGauge to respond with all the data from the startTimestamp
		// to the start of the current hour.
		const endTimestamp = 'soh';
		// This is the time stored when a meter is created and means no readings have yet been acquired.
		const E0 = moment(0).utc();
		// 900 seconds is 15 minutes, which is the default granularity that we will store for eGauge registers.
		// TODO We should allow the admin to decide the frequency of readings acquired.
		const timeStep = 900;
		// The eGauge meters stored on OED should be also have cumulative set to true.
		// We would have preferred gzip on the pull system, but we will continue with the assumption that transmissions are clean.
		if (E0.format('YYYY-MM-DD HH:mm:ss') === lastTimestamp.format('YYYY-MM-DD HH:mm:ss')) {
			// We assume that there is not so much data that crashes OED. Thus, we get all the data that the meter has.
			startTimestamp = 'epoch';
		} else {
			// This takes the date/time in the database on the meter, sets its timezone to be the one desired with
			// the same date/time and finally converts it to a unit timestamp. This will be the time to start
			// getting the meter readings.
			// TODO Other places may find the most recent end time for any reading on the desired meter and use
			// that. Need to decide if use that or this that uses lastTimestamp. An issue with this way is that
			// if it ever goes back in time then it may causes issues.
			startTimestamp = moment(lastTimestamp).tz(timezoneUse, true).unix();
		}
		return this.getMeterReadingsBetweenInterval(startTimestamp, endTimestamp, timeStep, timezoneUse);
	}

	/**
	 * Sets the register id on this instance based on the register name.
	 * The register id cannot be found on the eGauge UI side and so
	 * must be found programmatically. this.registerId is set to the correct
	 * register id on the eGauge device if found and unchanged if not.
	 */
	async setRegisterId() {
		const registerName = this.registerName;
		console.log('setRegisterId RegisterName: ', registerName);
		// Get register id from the eGauge device.
		// Earlier there was a plan to track if the register was physical or virtual on the eGauge
		// device (via registerType on this object). However, eGauge can return all registers and
		// each one has a unique idx value. As long as the name of the register is unique then this
		// works fine. It is unknown if physical and virtual registers on one meter can have the same
		// name but OED is assuming this is not done. Note a physical register also has a did but
		// virtual ones do not. Don't need time or rate to get all registers. Without rate better
		// since gets less data.
		// These are the parts of the request:
		// /register To get register based information.
		// virtual=value Unsure exact meaning but without it you don't get the desired information.
		// reg=all This get information on all registers.
		// format=json This returns information as JSON.
		const res = await this.get(`${this.apiUrl}/register/?virtual=value&reg=all&format=json`);
		// console.log('setRegisterId res.data.registers: ', res.data.registers);
		// Of all the registers on this eGauge meter, find the one that has the desired name.
		const register = res.data.registers.filter(reg => reg.name === registerName);
		// If there is not exactly one then a problem occurred. If zero then not found and if more
		// than one then name is not unique.
		this.registerId = register[0].idx;
		if (register.length !== 1) {
			log.error(`In trying to set the registerId, ${register.length} items found on meter`) +
				` "${this.meter.name}" for register "${this.registerName}. Using the first one returned` +
				` with the idx of ${this.registerId}.`;
		}
	}

	/**
	 * Logout the jwt.
	 * this.jwt and this.request headers are set to undefined.
	 */
	async logout() {
		if (this.jwt !== undefined) {
			await this.get(`${this.apiUrl}/auth/logout`);
			this.jwt = undefined;
			this.requestHeaders = undefined;
		}
	}

	/**
	 * A wrapper for axios.get; includes headers.
	 * @param {string} url for the request.
	 * @returns 
	 */
	async get(url) {
		return await axios.get(url, {
			headers: this.requestHeaders
		});
	}
}


module.exports = EgaugeRequestor;
