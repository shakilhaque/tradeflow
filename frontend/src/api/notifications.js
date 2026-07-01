import { client, apiCall } from './client'

/** Unread in-app notification count — used for header badge. */
export async function getUnreadCount() {
  const data = await apiCall(() => client.get('/api/notifications/unread-count/'))
  return data?.count ?? 0
}

/** List notifications with optional unread filter. */
export async function getNotifications({ limit = 50, unreadOnly = false } = {}) {
  return apiCall(() =>
    client.get('/api/notifications/', {
      params: { limit, unread_only: unreadOnly ? '1' : undefined },
    })
  )
}

/** Mark one notification as read. */
export async function markRead(notificationId) {
  return apiCall(() =>
    client.post(`/api/notifications/${notificationId}/read/`)
  )
}

/** Mark all notifications as read. */
export async function markAllRead() {
  return apiCall(() => client.post('/api/notifications/read-all/'))
}
