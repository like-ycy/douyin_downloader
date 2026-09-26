import { useState, type FormEvent } from 'react'

interface Props {
  disabled: boolean
  onSubmit: (link: string) => void
}

export function SearchBar({ disabled, onSubmit }: Props) {
  const [link, setLink] = useState('')

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    const trimmed = link.trim()
    if (trimmed && !disabled) onSubmit(trimmed)
  }

  return (
    <form className="searchbar" onSubmit={handleSubmit}>
      <input
        type="text"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="粘贴抖音视频链接，如 https://v.douyin.com/xxxx/"
        disabled={disabled}
        autoFocus
      />
      <button type="submit" disabled={disabled || !link.trim()}>
        解析
      </button>
    </form>
  )
}
