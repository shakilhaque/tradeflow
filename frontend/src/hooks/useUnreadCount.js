import { useState, useEffect, useRef, useCallback } from 'react'
import { getUnreadCount } from '../api/notifications'

const POLL_MS = 30_000   // refresh every 30 s

/**
 * Returns { count, refresh } — polls the unread notification count.
 * Safe to call on every render; only one interval runs.
 */
export default function useUnreadCount() {
  const [count, setCount] = useState(0)
  const intervalRef       = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const n = await getUnreadCount()
      setCount(n)
    } catch {
      // silently ignore — could be network error or 403
    }
  }, [])

  useEffect(() => {
    refresh()
    intervalRef.current = setInterval(refresh, POLL_MS)
    return () => clearInterval(intervalRef.current)
  }, [refresh])

  return { count, refresh }
}
