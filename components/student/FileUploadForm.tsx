

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { calculateMultiFileOrderPrice } from '../../utils/pricing';
import { DocumentOrder, PrintColor } from '../../types';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { SUPPORTED_FILE_TYPES, SUPPORTED_MIME_TYPES } from '../../constants';
import { Card } from '../common/Card';
import { PDFDocument } from 'pdf-lib';
import { Spinner } from '../common/Spinner';

interface FileUploadFormProps {
  userId: string;
  isLoadingShops: boolean;
  onNavigateToPass: () => void;
}

interface FileEntry {
  id: string;
  file: File;
  fileType: string;
  pageCount: number;
  color: PrintColor;
  copies: number;
  doubleSided: boolean;
  isParsing: boolean;
  parseError?: string;
}

const MAX_FILES = 10;

const getFileExtension = (filename: string): string => {
  return filename.slice(((filename.lastIndexOf(".") - 1) >>> 0) + 2).toUpperCase();
};

const FileUploadForm: React.FC<FileUploadFormProps> = ({ userId, isLoadingShops, onNavigateToPass }) => {
  const { addOrder, approvedShops, getShopById, currentUser } = useAppContext();

  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState<string>('');
  const [error, setError] = useState('');
  const [priceDetails, setPriceDetails] = useState<DocumentOrder['priceDetails']>({ pageCost: 0, baseFee: 0, totalPrice: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeShops = useMemo(() => approvedShops.filter(shop => shop.isOpen), [approvedShops]);

  useEffect(() => {
    if (isLoadingShops) return;
    if (!selectedShopId && activeShops.length > 0) {
      setSelectedShopId(activeShops[0].id);
    } else if (selectedShopId && activeShops.length > 0 && !activeShops.find(s => s.id === selectedShopId)) {
      setSelectedShopId(activeShops[0].id);
    } else if (activeShops.length === 0) {
      setSelectedShopId('');
    }
  }, [activeShops, isLoadingShops]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recalculate price
  const updateEstimatedPrice = useCallback(() => {
    if (isLoadingShops) return;
    const currentShop = getShopById(selectedShopId);
    if (!currentShop || fileEntries.length === 0) {
      setPriceDetails({ pageCost: 0, baseFee: 0, totalPrice: 0 });
      return;
    }

    const validFiles = fileEntries.filter(f => !f.isParsing && f.pageCount > 0 && f.copies > 0);
    if (validFiles.length === 0) {
      setPriceDetails({ pageCost: 0, baseFee: 0, totalPrice: 0 });
      return;
    }

    const newPriceDetails = calculateMultiFileOrderPrice(
      validFiles.map(f => ({ pageCount: f.pageCount, color: f.color, copies: f.copies, doubleSided: f.doubleSided })),
      currentShop.customPricing,
      currentUser?.hasStudentPass ?? false
    );
    setPriceDetails(newPriceDetails);
  }, [fileEntries, selectedShopId, getShopById, isLoadingShops, currentUser?.hasStudentPass]);

  useEffect(() => {
    updateEstimatedPrice();
  }, [updateEstimatedPrice]);

  const parsePdfPages = async (file: File): Promise<number> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  };

  const handleFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setError('');

    const remainingSlots = MAX_FILES - fileEntries.length;
    if (remainingSlots <= 0) {
      setError(`Maximum ${MAX_FILES} files per order.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const newFiles = Array.from(files).slice(0, remainingSlots);
    const newEntries: FileEntry[] = [];

    const IMAGE_EXTENSIONS = ['JPG', 'JPEG', 'PNG', 'HEIC', 'HEIF', 'WEBP', 'GIF', 'BMP', 'TIFF', 'SVG'];

    for (const file of newFiles) {
      const extension = getFileExtension(file.name);
      if (!SUPPORTED_FILE_TYPES.includes(extension)) {
        setError(`File "${file.name}" (.${extension.toLowerCase()}) is not supported. Supported: PDF, DOC(X), PPT(X), XLS(X), TXT, JPG, PNG, HEIC, WEBP, GIF.`);
        continue;
      }

      const isDuplicate = fileEntries.some(e => e.file.name === file.name) || newEntries.some(e => e.file.name === file.name);
      if (isDuplicate) {
        setError(`File "${file.name}" already added. Skipped.`);
        continue;
      }

      const isImage = IMAGE_EXTENSIONS.includes(extension);

      newEntries.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        fileType: extension,
        pageCount: isImage ? 1 : 1, // Images are always 1 page, PDFs get parsed below
        color: isImage ? PrintColor.COLOR : PrintColor.BLACK_WHITE, // Default images to color
        copies: 1,
        doubleSided: false,
        isParsing: extension === 'PDF', // Only parse PDFs for page count
      });
    }

    setFileEntries(prev => [...prev, ...newEntries]);

    for (const entry of newEntries) {
      if (entry.fileType === 'PDF') {
        try {
          const pages = await parsePdfPages(entry.file);
          setFileEntries(prev => prev.map(e =>
            e.id === entry.id ? { ...e, pageCount: pages, isParsing: false } : e
          ));
        } catch {
          setFileEntries(prev => prev.map(e =>
            e.id === entry.id ? { ...e, isParsing: false, parseError: 'Could not read PDF pages' } : e
          ));
        }
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (id: string) => {
    setFileEntries(prev => prev.filter(e => e.id !== id));
  };

  const updateFileColor = (id: string, color: PrintColor) => {
    setFileEntries(prev => prev.map(e => e.id === id ? { ...e, color } : e));
  };

  const updateFilePages = (id: string, pages: number) => {
    setFileEntries(prev => prev.map(e => e.id === id ? { ...e, pageCount: Math.max(1, pages) } : e));
  };

  const updateFileCopies = (id: string, copies: number) => {
    setFileEntries(prev => prev.map(e => e.id === id ? { ...e, copies: Math.max(1, copies) } : e));
  };

  const updateFileDoubleSided = (id: string, doubleSided: boolean) => {
    setFileEntries(prev => prev.map(e => e.id === id ? { ...e, doubleSided } : e));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoadingShops) { setError("Shop information is still loading."); return; }
    if (fileEntries.length === 0) { setError('Please select at least one file.'); return; }
    if (!selectedShopId) { setError('Please select a print shop.'); return; }

    const stillParsing = fileEntries.some(f => f.isParsing);
    if (stillParsing) { setError('Some files are still being processed. Please wait.'); return; }

    const invalidFiles = fileEntries.filter(f => f.pageCount <= 0 || f.copies <= 0);
    if (invalidFiles.length > 0) { setError('All files must have at least 1 page and 1 copy.'); return; }

    setError('');
    setIsSubmitting(true);

    const result = await addOrder({
      userId,
      shopId: selectedShopId,
      fileInputs: fileEntries.map(entry => ({
        file: entry.file,
        fileType: entry.fileType,
        pageCount: entry.pageCount,
        color: entry.color,
        copies: entry.copies,
        doubleSided: entry.doubleSided,
      })),
    });

    setIsSubmitting(false);

    if (result.success) {
      setFileEntries([]);
    }
  };

  if (isLoadingShops) {
    return (
      <div className="flex flex-col items-center justify-center p-10">
        <Spinner size="md" />
        <p className="mt-3 text-brand-lightText">Loading available shops...</p>
      </div>
    );
  }

  if (activeShops.length === 0) {
    return <p className="text-brand-warning text-center p-4 bg-yellow-700/20 rounded-lg">No print shops are currently open or available. Please check back later.</p>
  }

  const currentSelectedShop = getShopById(selectedShopId);
  const totalPages = fileEntries.reduce((sum, f) => sum + f.pageCount, 0);
  const anyParsing = fileEntries.some(f => f.isParsing);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Select
        label="Select Print Shop"
        id="shopSelection"
        value={selectedShopId}
        onChange={(e) => setSelectedShopId(e.target.value)}
        options={activeShops.map(shop => ({ value: shop.id, label: `${shop.name} (${shop.address})` }))}
        required
        containerClassName="mb-6"
        disabled={isLoadingShops || activeShops.length === 0}
      />
      {currentSelectedShop && (
        <p className="text-xs text-gray-700 dark:text-gray-300 font-medium -mt-4 mb-4">
          Rates for {currentSelectedShop.name}:
          B&amp;W: ₹{currentSelectedShop.customPricing.bwPerPage}/pg,
          Color: ₹{currentSelectedShop.customPricing.colorPerPage}/pg.
        </p>
      )}

      {/* File selection area */}
      <div>
        <label className="block text-sm font-medium text-brand-lightText mb-1.5">
          Select Files — PDFs, Docs, Images ({fileEntries.length}/{MAX_FILES})
        </label>
        <div
          className="mt-1 flex items-center space-x-3 p-4 border-2 border-dashed border-brand-primary/30 bg-brand-primary/5 rounded-lg hover:border-brand-primary hover:bg-brand-primary/10 transition-colors duration-300 cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Button
            type="button"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            variant="primary"
            size="md"
            disabled={fileEntries.length >= MAX_FILES || isSubmitting}
            leftIcon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" /></svg>}
          >
            Add Files
          </Button>
          <input
            type="file"
            id="fileUpload"
            ref={fileInputRef}
            onChange={handleFilesSelected}
            className="hidden"
            accept={[...SUPPORTED_FILE_TYPES.map(ft => `.${ft.toLowerCase()}`), ...SUPPORTED_MIME_TYPES].join(',')}
            multiple
            disabled={fileEntries.length >= MAX_FILES || isSubmitting}
          />
          {fileEntries.length === 0 && (
            <span className="text-sm text-gray-500 dark:text-gray-400 italic">No files selected. You can add up to {MAX_FILES} files.</span>
          )}
          {fileEntries.length > 0 && (
            <span className="text-sm text-brand-text font-medium">{fileEntries.length} file(s) selected • {totalPages} total pages</span>
          )}
        </div>
      </div>

      {/* File list with per-file settings */}
      {fileEntries.length > 0 && (
        <div className="space-y-4">
          {fileEntries.map((entry, index) => (
            <div
              key={entry.id}
              className="p-4 bg-brand-secondaryLight/50 dark:bg-zinc-800/50 rounded-xl border border-brand-muted/30 dark:border-zinc-700 transition-all hover:border-brand-primary/40"
            >
              {/* File header */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-bold text-brand-primary bg-brand-primary/10 px-2 py-1 rounded-lg flex-shrink-0">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-brand-text dark:text-white truncate" title={entry.file.name}>
                    {entry.file.name}
                  </p>
                  <p className="text-xs text-brand-lightText dark:text-gray-400">
                    {entry.fileType} • {(entry.file.size / 1024).toFixed(0)} KB
                    {entry.isParsing && <span className="ml-1 text-brand-primary"><Spinner size="sm" className="inline mr-1" />Detecting pages...</span>}
                    {!entry.isParsing && <span className="ml-1">• {entry.pageCount} pg{entry.pageCount !== 1 ? 's' : ''}</span>}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(entry.id)}
                  className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex-shrink-0"
                  title="Remove file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Per-file settings row */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Pages (editable for non-PDF or if parse failed) */}
                {(!entry.isParsing && (entry.fileType !== 'PDF' || entry.parseError)) && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-brand-lightText whitespace-nowrap">Pages:</label>
                    <input
                      type="number"
                      min="1"
                      value={entry.pageCount}
                      onChange={(e) => updateFilePages(entry.id, parseInt(e.target.value, 10) || 1)}
                      className="w-16 px-2 py-1.5 text-xs rounded-lg border border-brand-muted dark:border-zinc-600 bg-white dark:bg-zinc-800 text-brand-text dark:text-white focus:ring-1 focus:ring-brand-primary focus:outline-none"
                    />
                  </div>
                )}

                {/* Copies */}
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-brand-lightText whitespace-nowrap">Copies:</label>
                  <input
                    type="number"
                    min="1"
                    value={entry.copies}
                    onChange={(e) => updateFileCopies(entry.id, parseInt(e.target.value, 10) || 1)}
                    className="w-16 px-2 py-1.5 text-xs rounded-lg border border-brand-muted dark:border-zinc-600 bg-white dark:bg-zinc-800 text-brand-text dark:text-white focus:ring-1 focus:ring-brand-primary focus:outline-none"
                  />
                </div>

                {/* Color toggle */}
                <div className="flex rounded-lg border border-brand-muted dark:border-zinc-600 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => updateFileColor(entry.id, PrintColor.BLACK_WHITE)}
                    className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      entry.color === PrintColor.BLACK_WHITE
                        ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                        : 'bg-white dark:bg-zinc-800 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-700'
                    }`}
                  >
                    B&W
                  </button>
                  <button
                    type="button"
                    onClick={() => updateFileColor(entry.id, PrintColor.COLOR)}
                    className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      entry.color === PrintColor.COLOR
                        ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white'
                        : 'bg-white dark:bg-zinc-800 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-700'
                    }`}
                  >
                    Color
                  </button>
                </div>

                {/* Double-sided toggle (only show if >1 page) */}
                {entry.pageCount > 1 && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={entry.doubleSided}
                      onChange={(e) => updateFileDoubleSided(entry.id, e.target.checked)}
                      className="h-3.5 w-3.5 text-brand-primary bg-brand-secondaryLight border-brand-muted rounded focus:ring-brand-primary focus:ring-offset-brand-secondary"
                    />
                    <span className="text-xs text-brand-text dark:text-gray-300 font-medium">2-sided</span>
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-status-error bg-red-700/20 p-3 rounded-lg my-2">{error}</p>}

      <Card className="bg-brand-secondaryLight/60 dark:bg-brand-dark-surface/50 p-6 mt-6 border border-brand-muted/30 dark:border-brand-dark-border">
        <div className="flex justify-between items-end mb-2">
          <div>
            <h4 className="text-sm font-semibold text-brand-primary uppercase tracking-wider mb-1">Total Estimated Price</h4>
            <p className="text-4xl font-extrabold text-brand-text dark:text-white">₹{priceDetails.totalPrice.toFixed(2)}</p>
          </div>
          {fileEntries.length > 0 && (
            <div className="text-right text-xs text-brand-lightText">
              <p>{fileEntries.length} file{fileEntries.length > 1 ? 's' : ''} • {totalPages} pages</p>
              <p>Page Cost: ₹{priceDetails.pageCost.toFixed(2)} + Fee: ₹{priceDetails.baseFee.toFixed(2)}</p>
            </div>
          )}
        </div>
        <p className="text-xs text-brand-lightText/90 dark:text-brand-muted mt-3 italic">
          *One base fee per order regardless of file count. Double-sided is ~25% cheaper per page.
        </p>
      </Card>

      {/* Student Pass badge/upsell */}
      {currentUser?.hasStudentPass ? (
        <div className="w-full mb-6 p-4 rounded-xl border border-yellow-400/50 bg-gradient-to-r from-yellow-50 to-yellow-100 dark:from-yellow-900/20 dark:to-yellow-800/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="bg-yellow-400/30 p-2.5 rounded-full text-yellow-600 dark:text-yellow-400 ring-1 ring-yellow-500/50">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                  <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clipRule="evenodd" />
                </svg>
              </div>
              <div>
                <h5 className="font-bold text-gray-900 dark:text-gray-100 text-sm sm:text-base">Premium Member</h5>
                <p className="text-xs text-gray-700 dark:text-gray-300 font-medium">You get <span className="text-yellow-600 dark:text-yellow-400 font-bold">₹0 service fee</span> on orders under ₹30!</p>
              </div>
            </div>
            <div className="bg-yellow-500 text-black text-[10px] sm:text-xs font-bold px-3 py-1.5 rounded-full shadow-md">
              Active ✓
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onNavigateToPass}
          className="w-full mb-6 relative overflow-hidden group p-4 rounded-xl border border-yellow-400/30 bg-gradient-to-r from-yellow-50 to-yellow-100 dark:from-yellow-900/10 dark:to-yellow-800/10 hover:shadow-lg hover:shadow-yellow-400/20 transition-all duration-300 transform hover:-translate-y-0.5"
        >
          <div className="relative flex items-center justify-between">
            <div className="flex items-center space-x-3 text-left">
              <div className="bg-yellow-400/20 p-2.5 rounded-full text-yellow-600 dark:text-yellow-400 ring-1 ring-yellow-400/50">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                  <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813a3.75 3.75 0 0 0 2.576-2.576l.813-2.846A.75.75 0 0 1 9 4.5ZM1.5 9.75a.75.75 0 0 1 .156-.473l2.846-.813a.75.75 0 0 1 1.442 0l.813 2.846a.75.75 0 0 1-.473.91l-3.328 1.408a.75.75 0 0 1-.956-.566l-.5-3.312Zm7.768 7.768a.75.75 0 0 1 .473-.91l3.328-1.408a.75.75 0 0 1 .956.566l.5 3.312a.75.75 0 0 1-.156.473l-2.846.813a.75.75 0 0 1-1.442 0l-.813-2.846Z" clipRule="evenodd" />
                </svg>
              </div>
              <div>
                <h5 className="font-bold text-gray-900 dark:text-gray-100 text-sm sm:text-base">Save on service fees!</h5>
                <p className="text-xs text-gray-600 dark:text-gray-400">Get the Student Pass for just <span className="text-yellow-600 dark:text-yellow-400 font-bold">₹49/mo</span>.</p>
              </div>
            </div>
            <div className="bg-yellow-500 text-white text-[10px] sm:text-xs font-bold px-3 py-1.5 rounded-full shadow-md group-hover:scale-105 group-hover:bg-yellow-400 transition-all">
              Get Pass
            </div>
          </div>
        </button>
      )}

      <Button type="submit" size="lg" disabled={fileEntries.length === 0 || !selectedShopId || anyParsing || isSubmitting || isLoadingShops} fullWidth>
        {isSubmitting ? 'Uploading & Placing Order...' : anyParsing ? 'Processing Files...' : `Place Order & Proceed to Payment`}
      </Button>
    </form>
  );
};

export default FileUploadForm;
