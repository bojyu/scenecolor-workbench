import { useEffect, useState } from 'react'
import { Key, X } from '@phosphor-icons/react'

interface Props {
  nanoBananaApiKeys: string[]
  image2ApiKeys: string[]
  onSave: (nanoBananaKeys: string[], image2Keys: string[]) => void
  onClose: () => void
}

const toThreeSlots = (keys: string[]) => Array.from({ length: 3 }, (_, index) => keys[index] || '')

interface KeyGroupProps {
  title: string
  description: string
  slots: string[]
  prefix: string
  onChange: (index: number, value: string) => void
}

function KeyGroup({ title, description, slots, prefix, onChange }: KeyGroupProps) {
  return (
    <section className="key-group" aria-label={`${title} API Key`}>
      <div className="key-group-heading">
        <div><strong>{title}</strong><small>{description}</small></div>
        <span>{slots.filter(key => key.trim()).length}/3</span>
      </div>
      <div className="key-list">
        {slots.map((key, index) => (
          <div key={index} className="key-row">
            <span className="key-index">{index + 1}</span>
            <input
              className="key-input"
              type="password"
              autoComplete="off"
              aria-label={`${title} API Key ${index + 1}`}
              placeholder="sk-..."
              value={key}
              onChange={(event) => onChange(index, event.target.value)}
            />
            <span className="key-route-badge">{prefix}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function SettingsModal({ nanoBananaApiKeys, image2ApiKeys, onSave, onClose }: Props) {
  const [nanoBananaSlots, setNanoBananaSlots] = useState(() => toThreeSlots(nanoBananaApiKeys))
  const [image2Slots, setImage2Slots] = useState(() => toThreeSlots(image2ApiKeys))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const updateSlot = (setter: typeof setNanoBananaSlots, index: number, value: string) => {
    setter(previous => previous.map((key, currentIndex) => currentIndex === index ? value : key))
  }

  const handleSave = () => {
    onSave(
      nanoBananaSlots.map(key => key.trim()).filter(Boolean),
      image2Slots.map(key => key.trim()).filter(Boolean),
    )
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <span className="modal-heading-icon"><Key size={21} weight="bold" aria-hidden="true" /></span>
          <div><h2 id="settings-title">图像模型 API Key</h2><p>两组 Key 独立轮询，切换模型时自动使用对应通道。</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭设置"><X size={18} weight="bold" /></button>
        </div>

        <div className="key-groups">
          <KeyGroup
            title="Nano Banana 2"
            description="沿用原来的三条 Comfly Key"
            slots={nanoBananaSlots}
            prefix="NB2"
            onChange={(index, value) => updateSlot(setNanoBananaSlots, index, value)}
          />
          <KeyGroup
            title="Image 2"
            description="仅供 gpt-image-2 使用的三条专属 Key"
            slots={image2Slots}
            prefix="IMG2"
            onChange={(index, value) => updateSlot(setImage2Slots, index, value)}
          />
        </div>

        <p className="key-hint">每个模型最多并发 3 个请求；Key 只保存在当前浏览器的本地存储中。</p>

        <div className="modal-actions">
          <button type="button" className="btn-cancel" onClick={onClose}>取消</button>
          <button type="button" className="btn-save" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}
