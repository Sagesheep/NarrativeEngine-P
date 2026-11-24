import { Lock } from 'lucide-react';

/**
 * Explains where API keys live. Keys are stored encrypted in this browser's
 * storage on this device only; the server blanks every apiKey before it writes
 * settings to disk. Nothing here can cancel a leaked key: that happens at the
 * provider.
 */
export function KeyStorageNote() {
  return (
    <div className="mt-8 pt-6 border-t border-border space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <Lock size={14} className="text-terminal" />
        <label className="text-text-dim text-xs uppercase tracking-widest font-bold">API Keys</label>
      </div>
      <p className="text-[11px] text-text-dim leading-relaxed">
        Your API keys are stored encrypted on this device only. They are not written to the game&apos;s data folder,
        so copying that folder to another PC does not carry them. Re-enter them on each device.
      </p>
      <p className="text-[11px] text-text-dim leading-relaxed">
        Removing a key here does not cancel it. If a key may have leaked, revoke it on your provider&apos;s dashboard.
      </p>
    </div>
  );
}
