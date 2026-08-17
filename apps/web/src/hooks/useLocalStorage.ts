import { useCallback, useEffect, useState } from 'react'

/**
 * État React persisté dans localStorage. Tolère un storage indisponible
 * (navigation privée, cookies bloqués) en retombant sur un état mémoire.
 */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw === null ? initialValue : (JSON.parse(raw) as T)
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage indisponible — on garde juste l'état en mémoire
    }
  }, [key, value])

  const update = useCallback((next: T | ((prev: T) => T)) => setValue(next), [])

  return [value, update] as const
}
