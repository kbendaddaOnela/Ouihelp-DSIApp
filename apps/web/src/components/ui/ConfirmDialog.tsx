import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'default' | 'danger'

export type ConfirmOptions = {
  title?: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: Tone
  checkbox?: { label: string; defaultChecked?: boolean }
}
export type ConfirmResult = { confirmed: boolean; checked: boolean }
type AlertOptions = { title?: string; message?: ReactNode; okLabel?: string; tone?: Tone }

type Ctx = {
  confirm: (o: ConfirmOptions) => Promise<ConfirmResult>
  alert: (o: AlertOptions) => Promise<void>
}
const ConfirmCtx = createContext<Ctx | null>(null)

export function useConfirm(): Ctx {
  const c = useContext(ConfirmCtx)
  if (!c) throw new Error('useConfirm doit être utilisé dans un <ConfirmProvider>')
  return c
}

type DialogState =
  | ({ mode: 'confirm'; resolve: (r: ConfirmResult) => void } & ConfirmOptions)
  | ({ mode: 'alert'; resolve: () => void } & AlertOptions)
  | null

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null)
  const [checked, setChecked] = useState(false)

  const confirm = (o: ConfirmOptions) =>
    new Promise<ConfirmResult>((resolve) => {
      setChecked(o.checkbox?.defaultChecked ?? false)
      setState({ mode: 'confirm', resolve, ...o })
    })
  const alert = (o: AlertOptions) =>
    new Promise<void>((resolve) => setState({ mode: 'alert', resolve, ...o }))

  const close = (result: ConfirmResult | null) => {
    if (!state) return
    if (state.mode === 'confirm') state.resolve(result ?? { confirmed: false, checked: false })
    else state.resolve()
    setState(null)
  }

  // Esc = annuler, Entrée = valider
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(state.mode === 'confirm' ? { confirmed: false, checked } : null)
      else if (e.key === 'Enter') close(state.mode === 'confirm' ? { confirmed: true, checked } : null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, checked])

  const danger = state?.tone === 'danger'

  return (
    <ConfirmCtx.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => close(state.mode === 'confirm' ? { confirmed: false, checked } : null)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start gap-3 px-6 pt-6">
              <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', danger ? 'bg-red-50 text-red-600' : 'bg-primary-50 text-primary-600')}>
                {danger ? <AlertTriangle className="h-5 w-5" /> : <Info className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                {state.title && <h3 className="text-base font-semibold text-gray-900">{state.title}</h3>}
                {state.message && <div className="mt-1 whitespace-pre-line text-sm text-gray-600">{state.message}</div>}
              </div>
              <button onClick={() => close(state.mode === 'confirm' ? { confirmed: false, checked } : null)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            {state.mode === 'confirm' && state.checkbox && (
              <label className="mx-6 mt-4 flex cursor-pointer items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {state.checkbox.label}
              </label>
            )}

            <div className="mt-6 flex justify-end gap-2 bg-gray-50 px-6 py-4">
              {state.mode === 'confirm' && (
                <button
                  onClick={() => close({ confirmed: false, checked })}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
                >
                  {state.cancelLabel ?? 'Annuler'}
                </button>
              )}
              <button
                onClick={() => close(state.mode === 'confirm' ? { confirmed: true, checked } : null)}
                autoFocus
                className={cn(
                  'rounded-lg px-4 py-2 text-sm font-medium text-white',
                  danger ? 'bg-red-600 hover:bg-red-700' : 'bg-primary-600 hover:bg-primary-700'
                )}
              >
                {state.mode === 'confirm' ? (state.confirmLabel ?? 'Confirmer') : (state.okLabel ?? 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}
