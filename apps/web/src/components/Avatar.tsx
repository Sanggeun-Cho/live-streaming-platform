import { colorOf, initialOf } from '../lib/avatar'

export function Avatar({ id, name, size = 32 }: { id: number; name: string; size?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.45, background: colorOf(id) }}
    >
      {initialOf(name)}
    </span>
  )
}
