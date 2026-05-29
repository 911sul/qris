import React, { useState, useCallback, useRef } from 'react';
import { Upload, Copy, Check, CheckSquare, Square, QrCode, Banknote, Percent, FileText, Zap, Download, Lock } from 'lucide-react';
import QrScanner from 'qr-scanner';
import QRCode from 'qrcode';
import { ThemeToggle } from './components/ThemeToggle';
import { useTheme } from './contexts/ThemeContext';

type EmvTag = { id: string; value: string };

const parseTopLevelTags = (payload: string): EmvTag[] => {
  const result: EmvTag[] = [];
  let pos = 0;
  while (pos + 4 <= payload.length) {
    const id = payload.slice(pos, pos + 2);
    const lenStr = payload.slice(pos + 2, pos + 4);
    const len = parseInt(lenStr, 10);
    if (Number.isNaN(len) || len < 0) break;
    if (id === '63') {
      break;
    }
    const valueStart = pos + 4;
    const valueEnd = valueStart + len;
    const value = payload.slice(valueStart, valueEnd);
    result.push({ id, value });
    pos = valueEnd;
  }
  return result;
};

const buildPayloadWithoutCRC = (tags: EmvTag[]): string => {
  let s = '';
  for (const t of tags) {
    if (t.id === '63') continue;
    s += t.id + t.value.length.toString().padStart(2, '0') + t.value;
  }
  // Append CRC tag header without value
  s += '6304';
  return s;
};

const extractTagValue = (payload: string, tagId: string): string => {
  if (!payload) return '';
  const trimmed = payload.trim();
  if (trimmed.length < 6) return '';
  const withoutCrcValue = trimmed.length > 4 ? trimmed.slice(0, -4) : trimmed;
  const tags = parseTopLevelTags(withoutCrcValue);
  return tags.find(t => t.id === tagId)?.value ?? '';
};

interface QRISData {
  originalQris: string;
  amount: string;
  hasFee: boolean;
  feeType: 'rupiah' | 'percent';
  feeValue: string;
  dynamicQris: string;
  merchantName?: string;
  merchantCity?: string;
  countryCode?: string;
  postalCode?: string;
  preserveOriginalAmount: boolean;
}

function App() {
  const { theme } = useTheme();
  const [qrisData, setQrisData] = useState<QRISData>({
    originalQris: '',
    amount: '',
    hasFee: false,
    feeType: 'rupiah',
    feeValue: '',
    dynamicQris: '',
    merchantName: '',
    merchantCity: '',
    countryCode: 'ID',
    postalCode: '',
    preserveOriginalAmount: false
  });
  
  const [copied, setCopied] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isMerchantEditUnlocked, setIsMerchantEditUnlocked] = useState(false);
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [unlockPasswordInput, setUnlockPasswordInput] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const ADMIN_PASSWORD = (import.meta as any).env?.VITE_MERCHANT_PASSWORD as string | undefined;

  // CRC16 calculation function (converted from PHP)
  const calculateCRC16 = (str: string): string => {
    let crc = 0xFFFF;
    const strlen = str.length;
    
    for (let c = 0; c < strlen; c++) {
      crc ^= str.charCodeAt(c) << 8;
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
      }
    }
    
    const hex = (crc & 0xFFFF).toString(16).toUpperCase();
    return hex.padStart(4, '0');
  };

  // Convert static QRIS to dynamic
  const convertToDynamic = useCallback((data: QRISData): string => {
    if (!data.originalQris) return '';
    if (!data.amount && !data.preserveOriginalAmount) return '';
    try {
      const raw = data.originalQris.trim();
      if (raw.length < 10) return '';

      // Remove only the CRC value (last 4 hex chars); keep trailing '6304'
      const withoutCrcValue = raw.slice(0, -4);

      const originalTags = parseTopLevelTags(withoutCrcValue);
      const getOriginalValue = (tagId: string): string => originalTags.find(t => t.id === tagId)?.value || '';
      const originalAmount = getOriginalValue('54');
      const shouldOverrideAmount = !data.preserveOriginalAmount;
      const amountStr = shouldOverrideAmount ? data.amount : originalAmount;

      if (shouldOverrideAmount && !amountStr) {
        return '';
      }

      // Prepare new values with safe fallbacks to originals
      const feeValueStr = data.feeValue || '';
      const country = (data.countryCode?.trim().toUpperCase() || getOriginalValue('58') || 'ID').slice(0, 2);
      const merchantName = data.merchantName?.trim() || getOriginalValue('59');
      const merchantCity = data.merchantCity?.trim() || getOriginalValue('60');
      const postalCode = data.postalCode?.trim() || getOriginalValue('61');

      const group: EmvTag[] = [];
      const tagsToReplace = new Set<string>(['55', '56', '57', '58', '59', '60', '61']);

      if (shouldOverrideAmount && amountStr) {
        group.push({ id: '54', value: amountStr });
        tagsToReplace.add('54');
      }
      if (data.hasFee && feeValueStr) {
        if (data.feeType === 'rupiah') {
          // Keep existing scheme: 55=02 (fixed), 56=amount
          group.push({ id: '55', value: '02' });
          group.push({ id: '56', value: feeValueStr });
        } else {
          // 55=03 (percentage), 57=percent value
          group.push({ id: '55', value: '03' });
          group.push({ id: '57', value: feeValueStr });
        }
      }
      group.push({ id: '58', value: country });
      if (merchantName) group.push({ id: '59', value: merchantName });
      if (merchantCity) group.push({ id: '60', value: merchantCity });
      if (postalCode) group.push({ id: '61', value: postalCode });

      const updated: EmvTag[] = [];
      let inserted = false;
      let hasTag01 = false;
      for (const t of originalTags) {
        if (t.id === '01') {
          hasTag01 = true;
          // Force dynamic (12)
          updated.push({ id: '01', value: '12' });
          continue;
        }
        if (t.id === '58' && !inserted) {
          updated.push(...group);
          inserted = true;
          continue;
        }
        if (tagsToReplace.has(t.id)) {
          // Skip originals; they will be replaced by group
          continue;
        }
        updated.push(t);
      }
      if (!inserted && group.length > 0) {
        updated.push(...group);
      }
      if (!hasTag01) {
        updated.unshift({ id: '01', value: '12' });
      }

      const reconstructed = buildPayloadWithoutCRC(updated);
      const crc = calculateCRC16(reconstructed);
      return reconstructed + crc;
    } catch (error) {
      console.error('Error converting QRIS:', error);
      return '';
    }
  }, []);

  const originalAmount = React.useMemo(
    () => extractTagValue(qrisData.originalQris, '54'),
    [qrisData.originalQris]
  );
  const amountForDisplay = qrisData.preserveOriginalAmount
    ? originalAmount || qrisData.amount
    : qrisData.amount;

  // Handle form updates
  const updateQrisData = (updates: Partial<QRISData>) => {
    setQrisData(prev => {
      const newData = { ...prev, ...updates };
      newData.dynamicQris = convertToDynamic(newData);
      
      // Generate QR code when dynamic QRIS is updated
      if (newData.dynamicQris) {
        generateQRCode(newData.dynamicQris);
      } else {
        setQrCodeDataUrl('');
      }
      
      return newData;
    });
  };

  // Regenerate QR code when theme changes
  React.useEffect(() => {
    if (qrisData.dynamicQris) {
      generateQRCode(qrisData.dynamicQris);
    }
  }, [theme]);

  // Generate QR code from dynamic QRIS
  const generateQRCode = async (qrisData: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(qrisData, {
        width: 256,
        margin: 2,
        color: {
          dark: theme === 'dark' ? '#FFFFFF' : '#1F2937',
          light: theme === 'dark' ? '#1F2937' : '#FFFFFF'
        },
        errorCorrectionLevel: 'M'
      });
      setQrCodeDataUrl(dataUrl);
    } catch (error) {
      console.error('Error generating QR code:', error);
      setQrCodeDataUrl('');
    }
  };

  // Download QR code
  const downloadQRCode = () => {
    if (!qrCodeDataUrl) return;
    
    const link = document.createElement('a');
    link.download = `dynamic-qris-${Date.now()}.png`;
    link.href = qrCodeDataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Unlock merchant editing
  const submitUnlock = () => {
    setUnlockError('');
    const configured = (ADMIN_PASSWORD || '').toString();
    if (!configured) {
      setUnlockError('Admin password is not configured. Set VITE_MERCHANT_PASSWORD in your environment.');
      return;
    }
    if (unlockPasswordInput === configured) {
      setIsMerchantEditUnlocked(true);
      setIsUnlockModalOpen(false);
      setUnlockPasswordInput('');
      setUnlockError('');
    } else {
      setUnlockError('Incorrect password');
    }
  };

  // Handle QR code image upload
  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file containing a QR code');
      return;
    }

    setIsScanning(true);
    try {
      const result = await QrScanner.scanImage(file);
      updateQrisData({ originalQris: result });
    } catch (error) {
      console.error('Error scanning QR code:', error);
      alert('Could not read QR code from the image. Please make sure the image contains a clear QR code.');
    } finally {
      setIsScanning(false);
    }
  };

  // Drag and drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  // Copy to clipboard
  const copyToClipboard = async () => {
    if (!qrisData.dynamicQris) return;
    
    try {
      await navigator.clipboard.writeText(qrisData.dynamicQris);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  // Format currency input
  const formatCurrency = (value: string) => {
    return value.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
      {/* Header */}
      <div className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200/50 dark:border-gray-700/50 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg">
              <QrCode className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                Dynamic QRIS Generator
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">Convert static QRIS codes to dynamic with custom amounts</p>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <ThemeToggle />
            <button
              onClick={() => {
                if (isMerchantEditUnlocked) {
                  setIsMerchantEditUnlocked(false);
                } else {
                  setIsUnlockModalOpen(true);
                }
              }}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-all duration-150 ${
                isMerchantEditUnlocked
                  ? 'border-emerald-300 dark:border-emerald-600 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
              title={isMerchantEditUnlocked ? 'Click to lock' : 'Advanced'}
            >
              {isMerchantEditUnlocked ? <Check className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              {isMerchantEditUnlocked ? 'Unlocked' : 'Advanced'}
            </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Input Section */}
          <div className="space-y-6">
            {/* Unlock Modal */}
            {isUnlockModalOpen && (
              <div className="fixed inset-0 z-20 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/30 dark:bg-black/50" onClick={() => setIsUnlockModalOpen(false)} />
                <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <Lock className="h-5 w-5 text-gray-700 dark:text-gray-300" />
                    <h3 className="font-semibold text-gray-900 dark:text-gray-100">Enter Admin Password</h3>
                  </div>
                  <input
                    type="password"
                    value={unlockPasswordInput}
                    onChange={(e) => setUnlockPasswordInput(e.target.value)}
                    placeholder="Password"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent mb-2"
                    onKeyDown={(e) => { if (e.key === 'Enter') submitUnlock(); }}
                  />
                  {unlockError && (
                    <p className="text-sm text-red-600 dark:text-red-400 mb-2">{unlockError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setIsUnlockModalOpen(false)}
                      className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitUnlock}
                      className="px-3 py-2 text-sm rounded-lg bg-indigo-600 dark:bg-indigo-500 text-white hover:bg-indigo-700 dark:hover:bg-indigo-600"
                    >
                      Unlock
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* QRIS Input */}
            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-2xl p-6 border border-gray-200/50 dark:border-gray-700/50 shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Static QRIS Input</h2>
              </div>
              
              {/* File Upload Area */}
              <div
                className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-all duration-200 ${
                  isScanning
                    ? 'border-blue-500 bg-blue-50/50'
                    : 
                  dragActive 
                    ? 'border-blue-500 bg-blue-50/50' 
                    : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50/50'
                }`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={isScanning}
                />
                {isScanning ? (
                  <>
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 dark:border-blue-400 mx-auto mb-3"></div>
                    <p className="text-sm font-medium text-blue-700 dark:text-blue-400">Scanning QR code...</p>
                    <p className="text-xs text-blue-500 dark:text-blue-400 mt-1">Please wait</p>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-gray-400 dark:text-gray-500 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Drop your QR code image here</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">or click to browse (JPG, PNG, etc.)</p>
                  </>
                )}
              </div>

              {/* Text Input */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Or paste QRIS code directly:
                </label>
                <textarea
                  value={qrisData.originalQris}
                  onChange={(e) => updateQrisData({ originalQris: e.target.value })}
                  placeholder="Paste your static QRIS code here..."
                  className="w-full h-24 px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-sm font-mono"
                  disabled={isScanning}
                />
              </div>
            </div>

            {/* Amount Configuration */}
            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-2xl p-6 border border-gray-200/50 dark:border-gray-700/50 shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <Banknote className="h-5 w-5 text-green-600 dark:text-green-400" />
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Amount Configuration</h2>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Transaction Amount (IDR)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 text-sm">Rp</span>
                  <input
                    type="text"
                    value={formatCurrency(qrisData.preserveOriginalAmount ? originalAmount : qrisData.amount)}
                    onChange={(e) => updateQrisData({ amount: e.target.value.replace(/\D/g, '') })}
                    placeholder="0"
                    className="w-full pl-8 pr-3 py-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-lg disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
                    disabled={qrisData.preserveOriginalAmount}
                  />
                </div>
                {qrisData.preserveOriginalAmount && (
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                    {originalAmount
                      ? `Using original QRIS amount Rp ${formatCurrency(originalAmount)}`
                      : 'Original QRIS does not contain an amount tag.'}
                  </p>
                )}
              </div>

              {/* Service Fee Toggle */}
              <div className="mt-6">
                <div className="flex items-center gap-3 mb-4">
                  <input
                    type="checkbox"
                    id="hasFee"
                    checked={qrisData.hasFee}
                    onChange={(e) => updateQrisData({ hasFee: e.target.checked })}
                    className="w-4 h-4 text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 rounded focus:ring-orange-500"
                  />
                  <label htmlFor="hasFee" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Add service fee
                  </label>
                </div>

                {qrisData.hasFee && (
                  <div className="space-y-4 pl-7">
                    {/* Fee Type Selection */}
                    <div className="flex gap-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="feeType"
                          value="rupiah"
                          checked={qrisData.feeType === 'rupiah'}
                          onChange={() => updateQrisData({ feeType: 'rupiah' })}
                          className="w-4 h-4 text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:ring-orange-500"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1">
                          <Banknote className="h-4 w-4" />
                          Rupiah
                        </span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="feeType"
                          value="percent"
                          checked={qrisData.feeType === 'percent'}
                          onChange={() => updateQrisData({ feeType: 'percent' })}
                          className="w-4 h-4 text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:ring-orange-500"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1">
                          <Percent className="h-4 w-4" />
                          Percentage
                        </span>
                      </label>
                    </div>

                    {/* Fee Value Input */}
                    <div className="relative">
                      {qrisData.feeType === 'rupiah' ? (
                        <>
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 text-sm">Rp</span>
                          <input
                            type="text"
                            value={formatCurrency(qrisData.feeValue)}
                            onChange={(e) => updateQrisData({ feeValue: e.target.value.replace(/\D/g, '') })}
                            placeholder="0"
                            className="w-full pl-8 pr-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                          />
                        </>
                      ) : (
                        <>
                          <input
                            type="number"
                            value={qrisData.feeValue}
                            onChange={(e) => updateQrisData({ feeValue: e.target.value })}
                            placeholder="0"
                            min="0"
                            max="100"
                            step="0.01"
                            className="w-full pr-8 pl-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                          />
                          <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 text-sm">%</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Merchant Details (hidden behind password) */}
            {isMerchantEditUnlocked && (
              <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-2xl p-6 border border-gray-200/50 dark:border-gray-700/50 shadow-lg">
                <div className="flex items-center gap-3 mb-4">
                  <FileText className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Merchant Details</h2>
                </div>

                <div className="space-y-4 mb-6">
                  <button
                    type="button"
                    aria-pressed={qrisData.preserveOriginalAmount}
                    onClick={() =>
                      updateQrisData({ preserveOriginalAmount: !qrisData.preserveOriginalAmount })
                    }
                    className={`flex items-center justify-between w-full px-4 py-3 rounded-xl border text-left transition-all duration-150 ${
                      qrisData.preserveOriginalAmount
                        ? 'border-emerald-300 dark:border-emerald-600 bg-emerald-50/60 dark:bg-emerald-900/30 shadow-sm'
                        : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50/50 dark:hover:bg-gray-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {qrisData.preserveOriginalAmount ? (
                        <CheckSquare className="h-5 w-5 text-emerald-500" />
                      ) : (
                        <Square className="h-5 w-5 text-gray-400 dark:text-gray-500" />
                      )}
                      <div>
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                          Preserve original amount
                        </p>
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                          Leave the amount configuration untouched and lock the manual input field.
                        </p>
                      </div>
                    </div>
                  </button>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Merchant Name
                    </label>
                    <input
                      type="text"
                      value={qrisData.merchantName}
                      onChange={(e) => updateQrisData({ merchantName: e.target.value })}
                      placeholder="e.g., Toko Maju Jaya"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      City
                    </label>
                    <input
                      type="text"
                      value={qrisData.merchantCity}
                      onChange={(e) => updateQrisData({ merchantCity: e.target.value })}
                      placeholder="e.g., Jakarta"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Country Code
                    </label>
                    <input
                      type="text"
                      value={qrisData.countryCode}
                      onChange={(e) => updateQrisData({ countryCode: e.target.value.toUpperCase().slice(0, 2) })}
                      placeholder="ID"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent uppercase"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Postal Code
                    </label>
                    <input
                      type="text"
                      value={qrisData.postalCode}
                      onChange={(e) => updateQrisData({ postalCode: e.target.value.replace(/\D/g, '') })}
                      placeholder="e.g., 12950"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Output Section */}
          <div className="space-y-6">
            {/* Result Display */}
            <div className="bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm rounded-2xl p-6 border border-gray-200/50 dark:border-gray-700/50 shadow-lg">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Zap className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Dynamic QRIS Result</h2>
                </div>
                {qrisData.dynamicQris && (
                  <div className="flex gap-2">
                    <button
                      onClick={downloadQRCode}
                      className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-green-600 to-emerald-600 dark:from-green-500 dark:to-emerald-500 text-white rounded-lg hover:from-green-700 hover:to-emerald-700 dark:hover:from-green-600 dark:hover:to-emerald-600 transition-all duration-200 transform hover:scale-105"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </button>
                    <button
                      onClick={copyToClipboard}
                      className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 dark:from-purple-500 dark:to-pink-500 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 dark:hover:from-purple-600 dark:hover:to-pink-600 transition-all duration-200 transform hover:scale-105"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>

              {qrisData.dynamicQris ? (
                <div className="space-y-4">
                  {/* QR Code Display */}
                  {qrCodeDataUrl && (
                    <div className="flex justify-center">
                      <div className="p-4 bg-white dark:bg-gray-800 rounded-xl shadow-lg border-2 border-gray-100 dark:border-gray-700">
                        <img 
                          src={qrCodeDataUrl} 
                          alt="Dynamic QRIS QR Code"
                          className="w-64 h-64 object-contain"
                        />
                        <p className="text-center text-xs text-gray-500 dark:text-gray-400 mt-2">
                          Scan this QR code to make payment
                        </p>
                      </div>
                    </div>
                  )}
                  
                  <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Generated Dynamic QRIS:</p>
                    <p className="font-mono text-sm break-all text-gray-800 dark:text-gray-200 leading-relaxed">
                      {qrisData.dynamicQris}
                    </p>
                  </div>
                  
                  {/* Summary */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                      <p className="text-sm font-medium text-green-800 dark:text-green-400">Amount</p>
                      <p className="text-lg font-bold text-green-900 dark:text-green-300">
                        Rp {formatCurrency(amountForDisplay)}
                      </p>
                      {qrisData.preserveOriginalAmount && (
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-green-600 dark:text-green-400">
                          Original
                        </p>
                      )}
                    </div>
                    {qrisData.hasFee && qrisData.feeValue && (
                      <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                        <p className="text-sm font-medium text-orange-800 dark:text-orange-400">Service Fee</p>
                        <p className="text-lg font-bold text-orange-900 dark:text-orange-300">
                          {qrisData.feeType === 'rupiah' 
                            ? `Rp ${formatCurrency(qrisData.feeValue)}`
                            : `${qrisData.feeValue}%`
                          }
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12">
                  <QrCode className="h-16 w-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-500 dark:text-gray-400">Enter a static QRIS and amount to generate dynamic QRIS</p>
                </div>
              )}
              
              {/* Hidden canvas for QR generation */}
              <canvas ref={canvasRef} className="hidden" />
            </div>

            {/* Instructions */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-2xl p-6 border border-blue-200/50 dark:border-blue-700/50">
              <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-3">How to use:</h3>
              <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2">
                <li className="flex items-start gap-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 dark:bg-blue-500 text-white rounded-full text-xs flex items-center justify-center mt-0.5">1</span>
                  Upload a QR code image or paste the QRIS code directly
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 dark:bg-blue-500 text-white rounded-full text-xs flex items-center justify-center mt-0.5">2</span>
                  Enter the transaction amount in Indonesian Rupiah
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 dark:bg-blue-500 text-white rounded-full text-xs flex items-center justify-center mt-0.5">3</span>
                  Optionally add service fee (fixed amount or percentage)
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 dark:bg-blue-500 text-white rounded-full text-xs flex items-center justify-center mt-0.5">4</span>
                  Copy the generated dynamic QRIS for use in payment systems
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
