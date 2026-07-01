import { client, apiCall } from './client'

/** Platform-admin SMS Gateway (SSL Wireless) settings. */
export const getSmsGateway = () =>
  apiCall(() => client.get('/api/admin/sms-gateway/'))

/** Save credentials. Leave api_token blank to keep the existing token. */
export const saveSmsGateway = (data) =>
  apiCall(() => client.put('/api/admin/sms-gateway/', data))

/** Send a real test SMS to a number. */
export const testSmsGateway = ({ phone, message }) =>
  apiCall(() => client.post('/api/admin/sms-gateway/test/', { phone, message }))

/** Query + cache the SSL Wireless account balance. */
export const syncSmsBalance = () =>
  apiCall(() => client.post('/api/admin/sms-gateway/balance/', {}))
