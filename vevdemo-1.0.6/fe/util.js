import materialMap from './material';

const BASE_URL = (import.meta.env.VITE_VEVDEMO_API_BASE || '').replace(/\/$/, '');

export async function post(path, data) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }
  return response.json();
}

export async function get(path, data) {
  const query = new URLSearchParams(data).toString();
  const response = await fetch(`${BASE_URL}${path}?${query}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }
  return response.json();
}

export function getType(extension) {
  const target = materialMap.find((item) => item.format.includes(extension.toLowerCase()));

  return { type: target?.type, fileType: target?.fileType };
}
