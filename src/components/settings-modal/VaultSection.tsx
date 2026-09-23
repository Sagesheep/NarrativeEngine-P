import { useState, useRef } from 'react';
import { Loader2, Lock, Download, Upload } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';

export function VaultSection() {
  const { vaultStatus, exportVault, importVault, saveVaultKeys } = useAppStore(useShallow(s => ({
      vaultStatus: s.vaultStatus,
      exportVault: s.exportVault,
      importVault: s.importVault,
      saveVaultKeys: s.saveVaultKeys,
  })));
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [showExportPassword, setShowExportPassword] = useState(false);
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [mergeImport, setMergeImport] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!exportPassword) {
      toast.error('Please enter an export password');
      return;
    }
    setIsExporting(true);
    try {
      // First save current keys to vault
      await saveVaultKeys();
      const blob = await exportVault(exportPassword);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'narrative-engine-keys.nevault';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Vault exported - share the .nevault file and password separately');
      setExportPassword('');
    } catch (e) {
      toast.error('Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!importPassword) {
      toast.error('Please enter the import password first');
      return;
    }

    setIsImporting(true);
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const arrayBuffer = event.target?.result as ArrayBuffer;
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          await importVault(base64, importPassword, mergeImport);
          setImportPassword('');
          if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (err) {
          toast.error('Import failed - wrong password or corrupted file');
        } finally {
          setIsImporting(false);
        }
      };
      reader.onerror = () => {
        toast.error('Failed to read file');
        setIsImporting(false);
      };
      reader.readAsArrayBuffer(file);
    } catch (e) {
      toast.error('Failed to read file');
      setIsImporting(false);
    }
  };

  // Don't show if vault doesn't exist
  if (!vaultStatus?.exists) {
    return null;
  }

  return (
    <div className="mt-8 pt-6 border-t border-border space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Lock size={14} className="text-terminal" />
        <label className="text-text-dim text-xs uppercase tracking-widest font-bold">
          Vault Export/Import
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {/* Export Section */}
        <div className="bg-void border border-border p-4 rounded">
          <p className="text-[11px] text-text-dim uppercase tracking-wider mb-3">Export Vault</p>
          <p className="text-[10px] text-text-dim/70 mb-3">
            Create an encrypted file to share your API keys with others. They&apos;ll need the separate password to decrypt.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showExportPassword ? 'text' : 'password'}
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                placeholder="Export password"
                className="w-full bg-surface border border-border px-3 py-2 pr-8 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowExportPassword(!showExportPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary"
              >
                {showExportPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              onClick={handleExport}
              disabled={isExporting || !exportPassword}
              className="bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest px-4 py-2 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {isExporting ? (
                <><Loader2 size={14} className="animate-spin" />...</>
              ) : (
                <><Download size={14} /> Export</>
              )}
            </button>
          </div>
        </div>

        {/* Import Section */}
        <div className="bg-void border border-border p-4 rounded">
          <p className="text-[11px] text-text-dim uppercase tracking-wider mb-3">Import Vault</p>
          <p className="text-[10px] text-text-dim/70 mb-3">
            Import an encrypted vault file. Current presets will be merged or replaced based on your selection.
          </p>

          <div className="flex items-center gap-2 mb-3">
            <input
              type="checkbox"
              id="mergeImport"
              checked={mergeImport}
              onChange={(e) => setMergeImport(e.target.checked)}
              className="w-4 h-4 accent-terminal"
            />
            <label htmlFor="mergeImport" className="text-xs text-text-dim">Merge with existing presets</label>
          </div>

          <div className="flex gap-2 mb-3">
            <div className="flex-1 relative">
              <input
                type={showImportPassword ? 'text' : 'password'}
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                placeholder="Import password"
                className="w-full bg-surface border border-border px-3 py-2 pr-8 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowImportPassword(!showImportPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary"
              >
                {showImportPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".nevault"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting || !importPassword}
              className="w-full bg-surface border border-border hover:border-terminal text-text-primary text-xs uppercase tracking-widest px-4 py-2 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isImporting ? (
                <><Loader2 size={14} className="animate-spin" /> Importing...</>
              ) : (
                <><Upload size={14} /> Select .nevault File</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
