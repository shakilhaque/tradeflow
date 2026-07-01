import { useEffect, useState } from 'react'
import { getPublicCms } from '../api/cms'

// Module-level cache so every public page shares ONE request per page load.
let _cache = null
let _promise = null

export function getPublicCmsCached() {
  if (_cache) return Promise.resolve(_cache)
  if (!_promise) {
    _promise = getPublicCms()
      .then((d) => { _cache = d || { blocks: {}, collections: {} }; return _cache })
      .catch(() => { _promise = null; return { blocks: {}, collections: {} } })
  }
  return _promise
}

/**
 * Returns admin-managed CMS content: { blocks, collections }. Pages override
 * their built-in defaults with these values where present.
 */
export function usePublicCms() {
  const [data, setData] = useState(_cache)
  useEffect(() => {
    let alive = true
    getPublicCmsCached().then((d) => { if (alive) setData(d) })
    return () => { alive = false }
  }, [])
  return data || { blocks: {}, collections: {} }
}
