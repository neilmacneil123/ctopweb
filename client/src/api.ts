import type { ContainerDetail, ContainerResponse } from './types'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000')

export async function fetchContainers(): Promise<ContainerResponse> {
  const response = await fetch(`${API_BASE_URL}/api/containers`)

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || 'Failed to load container stats')
  }

  return response.json()
}

export async function fetchContainerDetail(id: string): Promise<ContainerDetail> {
  const response = await fetch(`${API_BASE_URL}/api/containers/${id}`)

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || 'Failed to load container detail')
  }

  return response.json()
}
