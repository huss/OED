/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import axios, {AxiosResponse} from 'axios';
import {BarReadings, LineReadings} from '../types/readings';
import { TimeInterval } from '../../../common/TimeInterval';
import * as moment from 'moment';
import {NamedIDItem, PreferenceRequestItem} from '../types/items';
import {getToken, hasToken} from './token';
import {GroupData, GroupID} from '../types/redux/groups';

/**
 * Provides access to the backend.
 */
class Api {

	public async metersDetails(): Promise<NamedIDItem[]> {
		return await this.doGetRequest<NamedIDItem[]>('/api/meters');
	}

	public async groupsDetails(): Promise<NamedIDItem[]> {
		return await this.doGetRequest<NamedIDItem[]>('/api/groups');
	}

	public async groupChildren(groupID: number): Promise<{meters: number[], groups: number[]}> {
		return await this.doGetRequest<{meters: number[], groups: number[]}>(`api/groups/children/${groupID}`);
	}

	public async meterLineReadings(meterIDs: number[], timeInterval: TimeInterval): Promise<LineReadings> {
		const stringifiedIDs = meterIDs.join(',');
		return await this.doGetRequest<LineReadings>(
			`/api/readings/line/meters/${stringifiedIDs}`,
			{ timeInterval: timeInterval.toString() }
			);
	}

	public async groupLineReadings(groupIDs: number[], timeInterval: TimeInterval): Promise<LineReadings> {
		const stringifiedIDs = groupIDs.join(',');
		return await this.doGetRequest<LineReadings>(
			`/api/readings/line/groups/${stringifiedIDs}`,
			{ timeInterval: timeInterval.toString() }
		);
	}

	public async meterBarReadings(meterIDs: number[], timeInterval: TimeInterval, barDuration: moment.Duration): Promise<BarReadings> {
		const stringifiedIDs = meterIDs.join(',');
		return await this.doGetRequest<BarReadings>(
			`/api/readings/bar/meters/${stringifiedIDs}`,
			{ timeInterval: timeInterval.toString(), barDuration: barDuration.toISOString() }
		);
	}

	public async groupBarReadings(groupIDs: number[], timeInterval: TimeInterval, barDuration: moment.Duration): Promise<BarReadings> {
		const stringifiedIDs = groupIDs.join(',');
		return await this.doGetRequest<BarReadings>(
			`/api/readings/bar/groups/${stringifiedIDs}`,
			{ timeInterval: timeInterval.toString(), barDuration: barDuration.toISOString() }
		);
	}

	public async createGroup(groupData: GroupData): Promise<void> {
		return await this.doAuthPostRequest<void>('api/groups/create', groupData);
	}

	public async editGroup(group: GroupData & GroupID): Promise<void> {
		return await this.doAuthPutRequest<void>('api/groups/edit', group);
	}

	public async deleteGroup(groupID: number) {
		return await this.doAuthPostRequest('api/groups/delete', {id: groupID});
	}

	public async getPreferences(): Promise<PreferenceRequestItem> {
		return await this.doGetRequest<PreferenceRequestItem>('/api/preferences');
	}

	public async submitPreferences(preferences: PreferenceRequestItem): Promise<void> {
		await this.doAuthPostRequest('/api/preferences', { preferences });
	}

	public async checkTokenValid(): Promise<boolean> {
		// This will not throw an error if the status code is 401 unauthorized or 403 forbidden
		const response: AxiosResponse = await axios.post('/api/verification/',
			{ token: getToken() },
			{ validateStatus: status => (status >= 200 && status < 300) || (status === 401 || status === 403) });
		// The server returns { success: true } if and only if the token is valid.
		return response.data.success === true;
	}

	public async login(email: string, password: string): Promise<string> {
		const response = await this.doPostRequest<{token: string}>('/api/login/', {email, password});
		return response.token;
	}

	public async submitNewMeterReadings(meterID: number, readingsFile: File): Promise<void> {
		const formData = new FormData();
		formData.append('csvFile', readingsFile);
		return await this.doAuthPostRequest<void>(`/api/fileProcessing/${meterID}`, formData);
	}

	private async doGetRequest<R>(
		url: string,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		const response: AxiosResponse = await axios.get(url, { params, headers });
		return response.data as R;
	}

	private async doPutRequest<R>(
		url: string,
		body: any,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		const response: AxiosResponse = await axios.put(url, body, { params, headers });
		return response.data as R;
	}

	private async doPostRequest<R>(
		url: string,
		body: any,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		const response: AxiosResponse = await axios.post(url, body, { params, headers });
		return response.data as R;
	}

	private async doAuthGetRequest<R>(
		url: string,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		return await this.doGetRequest<R>(url, params, {token: getToken(), ...headers});
	}

	private async doAuthPutRequest<R>(
		url: string,
		body: any,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		return await this.doPutRequest<R>(url, body, params, {token: getToken(), ...headers});
	}

	private async doAuthPostRequest<R>(
		url: string,
		body: any,
		params: { [key: string]: string } = {},
		headers: { [key: string]: string } = {}
	): Promise<R> {
		return await this.doPostRequest<R>(url, body, params, {token: getToken(), ...headers});
	}
}

export default new Api();
