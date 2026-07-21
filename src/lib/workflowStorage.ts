import type { DetailRedrawQueueItem, VerificationQueueItem } from '../types'

export const VERIFICATION_QUEUE_KEY = 'scenecolor_verification_queue_v1'
export const DETAIL_REDRAW_QUEUE_KEY = 'scenecolor_detail_redraw_queue_v1'

export function loadQueue<T>(key: string): T[] {
  try {
    const value = localStorage.getItem(key)
    const parsed = value ? JSON.parse(value) : []
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export function saveVerificationQueue(items: VerificationQueueItem[]): void {
  const compact = items.map(({ outputImage: _outputImage, sceneImage: _sceneImage, productImage: _productImage, ...item }) => item)
  localStorage.setItem(VERIFICATION_QUEUE_KEY, JSON.stringify(compact))
}

export function saveDetailRedrawQueue(items: DetailRedrawQueueItem[]): void {
  const compact = items.map(({ verifiedImage: _verifiedImage, sceneImage: _sceneImage, productImage: _productImage, ...item }) => item)
  localStorage.setItem(DETAIL_REDRAW_QUEUE_KEY, JSON.stringify(compact))
}
