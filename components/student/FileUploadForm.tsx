

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAppContext, calculateOrderPrice } from '../../contexts/AppContext';
import { DocumentOrder, PrintOptions, PrintColor } from '../../types'; // Removed ShopProfile
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { SUPPORTED_FILE_TYPES } from '../../constants';
import { Card } from '../common/Card';
import { PDFDocument } from 'pdf-lib';
import { Spinner } from '../common/Spinner';


interface FileUploadFormProps {
  userId: string;
  isLoadingShops: boolean; 
}

const getFileExtension = (filename: string): string => {
  return filename.slice(((filename.lastIndexOf(".") - 1) >>> 0) + 2).toUpperCase();
};

const FileUploadForm: React.FC<FileUploadFormProps> = ({ userId, isLoadingShops }) => {
  const { addOrder, shops, getShopById } = useAppContext();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState(''); // Determined from file
  const [isParsingPdf, setIsParsingPdf] = useState(false);

  // Print options state
  const [copiesInputString, setCopiesInputString] = useState('1');
  const [effectiveCopies, setEffectiveCopies] = useState(1);
  const [color, setColor] = useState<PrintColor>(PrintColor.BLACK_WHITE);
  const [doubleSided, setDoubleSided] = useState(false);

  // Page handling state
  const [manualPagesInputString, setManualPagesInputString] = useState('1'); // For non-PDFs or if PDF parsing fails
  const [effectivePagesToPrint, setEffectivePagesToPrint] = useState(1); // Final pages for calculation

  const [detectedTotalPdfPages, setDetectedTotalPdfPages] = useState<number | null>(null);
  const [printRangeOption, setPrintRangeOption] = useState<'full' | 'custom'>('full');
  const [customStartPageString, setCustomStartPageString] = useState('1');
  const [customEndPageString, setCustomEndPageString] = useState('1');
  const [effectiveStartPage, setEffectiveStartPage] = useState(1);
  const [effectiveEndPage, setEffectiveEndPage] = useState(1);

  const [selectedShopId, setSelectedShopId] = useState<string>('');
  const [error, setError] = useState('');
  const [priceDetails, setPriceDetails] = useState<DocumentOrder['priceDetails']>({ pageCost: 0, baseFee: 0, totalPrice: 0});
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [activeShops, setActiveShops] = useState(shops.filter(shop => shop.isOpen));

  useEffect(() => {
    if (!isLoadingShops) {
        setActiveShops(shops.filter(shop => shop.isOpen));
    }
  }, [shops, isLoadingShops]);


  useEffect(() => {
    if (isLoadingShops) return; // Don't run if shops are still loading

    if (activeShops.length > 0 && !activeShops.find(s => s.id === selectedShopId)) {
        setSelectedShopId(activeShops[0].id);
    } else if (activeShops.length === 0 && selectedShopId) {
        setSelectedShopId('');
    }
  }, [activeShops, selectedShopId, isLoadingShops]);

  // Recalculate effective pages to print whenever relevant page states change
  useEffect(() => {
    let pagesForCalc = 1;
    if (detectedTotalPdfPages && printRangeOption === 'full') {
      pagesForCalc = detectedTotalPdfPages;
    } else if (detectedTotalPdfPages && printRangeOption === 'custom') {
      pagesForCalc = Math.max(0, effectiveEndPage - effectiveStartPage + 1);
    } else { // Not a PDF or parsing failed - use manual input
      pagesForCalc = parseInt(manualPagesInputString, 10) || 1;
      if (pagesForCalc <=0) pagesForCalc = 1; // Ensure at least 1 for manual
    }
    setEffectivePagesToPrint(pagesForCalc);
  }, [detectedTotalPdfPages, printRangeOption, effectiveStartPage, effectiveEndPage, manualPagesInputString]);

  // Update estimated price whenever effective options change
  const updateEstimatedPrice = useCallback(() => {
    if (isLoadingShops) return; 
    const currentShop = getShopById(selectedShopId);
    if (!currentShop || effectivePagesToPrint <= 0 || effectiveCopies <= 0) {
        setPriceDetails({ pageCost: 0, baseFee: 0, totalPrice: 0 });
        return;
    }
    const currentPrintOptions: PrintOptions = {
        copies: effectiveCopies,
        color,
        pages: effectivePagesToPrint,
        doubleSided
    };
    const newPriceDetails = calculateOrderPrice(currentPrintOptions, currentShop.customPricing);
    setPriceDetails(newPriceDetails);
  }, [effectiveCopies, color, effectivePagesToPrint, doubleSided, selectedShopId, getShopById, isLoadingShops]);

  useEffect(() => {
    updateEstimatedPrice();
  }, [updateEstimatedPrice]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelectedFile(null);
    setFileType('');
    setDetectedTotalPdfPages(null);
    setPrintRangeOption('full'); // Reset print range option
    setManualPagesInputString('1'); // Reset manual pages input
    setError('');

    if (file) {
      const extension = getFileExtension(file.name);
      if (!SUPPORTED_FILE_TYPES.includes(extension)) {
        setError(`File type .${extension.toLowerCase()} is not supported. Please use one of: ${SUPPORTED_FILE_TYPES.join(', ')}.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setSelectedFile(file);
      setFileType(extension);

      if (extension === 'PDF') {
        setIsParsingPdf(true);
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
          const numPages = pdfDoc.getPageCount();
          setDetectedTotalPdfPages(numPages);
          setCustomEndPageString(numPages.toString()); // Default custom end page to total
          setEffectiveEndPage(numPages);
          setManualPagesInputString(numPages.toString()); // Also prefill manual as fallback or initial view
        } catch (pdfError) {
          console.error("Error parsing PDF: ", pdfError);
          setError("Could not read page count from PDF. Please enter manually.");
          setDetectedTotalPdfPages(null); // Fallback to manual input
        } finally {
          setIsParsingPdf(false);
        }
      }
    }
  };

  // Handlers for blur to parse and validate string inputs for numbers
  const handleCopiesBlur = () => {
    const parsedCopies = parseInt(copiesInputString, 10);
    setEffectiveCopies(Math.max(1, isNaN(parsedCopies) ? 1 : parsedCopies));
    setCopiesInputString(String(Math.max(1, isNaN(parsedCopies) ? 1 : parsedCopies))); // Reflect validation in input
  };

  const handleManualPagesBlur = () => {
    const parsedPages = parseInt(manualPagesInputString, 10);
    const validPages = Math.max(1, isNaN(parsedPages) ? 1 : parsedPages);
    setManualPagesInputString(validPages.toString()); // Update string state to reflect validation
  };

  const handleCustomStartPageBlur = () => {
    const parsed = parseInt(customStartPageString, 10);
    const newStart = Math.max(1, isNaN(parsed) ? 1 : parsed);
    setCustomStartPageString(newStart.toString());
    setEffectiveStartPage(newStart);
    // Ensure end page is not less than start page
    if (detectedTotalPdfPages && newStart > effectiveEndPage) {
        setCustomEndPageString(newStart.toString());
        setEffectiveEndPage(newStart);
    }
  };

  const handleCustomEndPageBlur = () => {
    const parsed = parseInt(customEndPageString, 10);
    const maxPages = detectedTotalPdfPages || effectiveStartPage; // Ensure end page is not less than start, or total
    const newEnd = Math.min(maxPages, Math.max(effectiveStartPage, isNaN(parsed) ? effectiveStartPage : parsed));
    setCustomEndPageString(newEnd.toString());
    setEffectiveEndPage(newEnd);
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoadingShops) { setError("Shop information is still loading. Please wait."); return;}
    if (!selectedFile) { setError('Please select a file to upload.'); return; }
    if (!selectedShopId) { setError('Please select a print shop.'); return; }

    // Final validation before submitting
    if (effectivePagesToPrint <= 0) { setError('Number of pages to print must be at least 1.'); return; }
    if (effectiveCopies <= 0) { setError('Number of copies must be at least 1.'); return; }

    if (detectedTotalPdfPages && printRangeOption === 'custom') {
      if (effectiveStartPage > effectiveEndPage) { setError('Start page cannot be greater than end page.'); return; }
      if (effectiveStartPage <= 0) { setError('Start page must be at least 1.'); return; }
      if (effectiveEndPage > detectedTotalPdfPages) { setError(`End page cannot exceed total pages in PDF (${detectedTotalPdfPages}).`); return; }
    }

    const targetShop = getShopById(selectedShopId);
    if (!targetShop) { setError('Selected shop is not available.'); return; }

    setError('');

    const printOptionsData: PrintOptions = {
      copies: effectiveCopies,
      color,
      pages: effectivePagesToPrint,
      doubleSided,
      ...(detectedTotalPdfPages && printRangeOption === 'custom' && { startPage: effectiveStartPage, endPage: effectiveEndPage })
    };

    await addOrder({
      userId,
      shopId: selectedShopId,
      fileName: selectedFile.name,
      fileType: fileType,
      fileObject: selectedFile,
      printOptions: printOptionsData,
      priceDetailsInput: {shopId: selectedShopId, printOptions: printOptionsData }
    });

    // Reset form
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setFileType('');
    setCopiesInputString('1'); setEffectiveCopies(1);
    setColor(PrintColor.BLACK_WHITE);
    setDoubleSided(false);
    setManualPagesInputString('1');
    setDetectedTotalPdfPages(null);
    setPrintRangeOption('full');
    setCustomStartPageString('1'); setEffectiveStartPage(1);
    setCustomEndPageString('1'); setEffectiveEndPage(1);
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
        <p className="text-xs text-brand-muted -mt-4 mb-4">
            Current rates for {currentSelectedShop.name}:
            B&amp;W: ₹{currentSelectedShop.customPricing.bwPerPage}/pg,
            Color: ₹{currentSelectedShop.customPricing.colorPerPage}/pg.
        </p>
      )}

      <div>
        <label htmlFor="fileUpload" className="block text-sm font-medium text-brand-lightText mb-1.5">
          Select Document
        </label>
        <div className="mt-1 flex items-center space-x-3 p-4 border-2 border-dashed border-brand-muted rounded-lg hover:border-brand-primary transition-colors">
            <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                variant="secondary"
                size="md"
                disabled={isParsingPdf}
                leftIcon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" /></svg>}
            >
            Choose File
            </Button>
            <input
                type="file"
                id="fileUpload"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept={SUPPORTED_FILE_TYPES.map(ft => `.${ft.toLowerCase()}`).join(',')}
                disabled={isParsingPdf}
            />
            {isParsingPdf && <Spinner size="sm" />}
            {selectedFile && !isParsingPdf && <span className="text-sm text-brand-lightText truncate max-w-xs" title={selectedFile.name}>{selectedFile.name} ({fileType})</span>}
            {!selectedFile && !isParsingPdf &&<span className="text-sm text-brand-muted">No file selected.</span>}
        </div>
      </div>

      {selectedFile && fileType === 'PDF' && detectedTotalPdfPages !== null && (
        <Card className="bg-brand-secondaryLight/50 p-4 border border-brand-muted/30" noPadding>
          <div className="p-4">
            <p className="text-sm text-brand-text mb-2">PDF Detected: <strong>{detectedTotalPdfPages} pages</strong>. Choose print range:</p>
            <div className="flex space-x-4 mb-3">
                <label className="flex items-center space-x-2 p-2 border border-brand-muted rounded-lg hover:border-brand-primary cursor-pointer has-[:checked]:bg-brand-primary/10 has-[:checked]:border-brand-primary">
                    <input type="radio" name="printRange" value="full" checked={printRangeOption === 'full'} onChange={() => setPrintRangeOption('full')} className="form-radio text-brand-primary focus:ring-brand-primary"/>
                    <span>Full Document ({detectedTotalPdfPages} pages)</span>
                </label>
                <label className="flex items-center space-x-2 p-2 border border-brand-muted rounded-lg hover:border-brand-primary cursor-pointer has-[:checked]:bg-brand-primary/10 has-[:checked]:border-brand-primary">
                    <input type="radio" name="printRange" value="custom" checked={printRangeOption === 'custom'} onChange={() => setPrintRangeOption('custom')} className="form-radio text-brand-primary focus:ring-brand-primary"/>
                    <span>Custom Range</span>
                </label>
            </div>
            {printRangeOption === 'custom' && (
              <div className="grid grid-cols-2 gap-4 mt-2">
                <Input label="Start Page" id="customStartPage" type="text" inputMode="numeric"
                       value={customStartPageString}
                       onChange={(e) => setCustomStartPageString(e.target.value.replace(/\D/g,''))}
                       onBlur={handleCustomStartPageBlur} />
                <Input label="End Page" id="customEndPage" type="text" inputMode="numeric"
                       value={customEndPageString}
                       onChange={(e) => setCustomEndPageString(e.target.value.replace(/\D/g,''))}
                       onBlur={handleCustomEndPageBlur} />
              </div>
            )}
          </div>
        </Card>
      )}

      {(!selectedFile || fileType !== 'PDF' || detectedTotalPdfPages === null) && (
        <Input
            label="Number of Pages (Estimate)"
            id="manualPages"
            type="text"
            inputMode="numeric"
            value={manualPagesInputString}
            onChange={(e) => setManualPagesInputString(e.target.value.replace(/\D/g,''))}
            onBlur={handleManualPagesBlur}
            required
        />
      )}

      <p className="text-sm text-brand-lightText -mt-2">Effective Pages to Print: <strong className="text-brand-text">{effectivePagesToPrint}</strong></p>


      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
        <Input
            label="Number of Copies"
            id="copies"
            type="text"
            inputMode="numeric"
            value={copiesInputString}
            onChange={(e) => setCopiesInputString(e.target.value.replace(/\D/g,''))}
            onBlur={handleCopiesBlur}
            required
        />
        <Select
            label="Print Color"
            id="color"
            value={color}
            onChange={(e) => setColor(e.target.value as PrintColor)}
            options={[
            { value: PrintColor.BLACK_WHITE, label: 'Black & White' },
            { value: PrintColor.COLOR, label: 'Color' },
            ]}
        />
         <div className="flex items-center pt-5">
          <input
            id="doubleSided"
            name="doubleSided"
            type="checkbox"
            checked={doubleSided}
            onChange={(e) => setDoubleSided(e.target.checked)}
            className="h-4 w-4 text-brand-primary bg-brand-secondaryLight border-brand-muted rounded focus:ring-brand-primary focus:ring-offset-brand-secondary"
          />
          <label htmlFor="doubleSided" className="ml-2 block text-sm text-brand-lightText">
            Double-sided printing
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-status-error bg-red-700/20 p-3 rounded-lg my-2">{error}</p>}

      <Card className="bg-brand-secondaryLight/60 p-4 mt-4 border border-brand-muted/30">
        <h4 className="text-md font-semibold text-brand-primary mb-1">Estimated Price:</h4>
        <p className="text-3xl font-bold text-brand-text">₹{priceDetails.totalPrice.toFixed(2)}</p>
        <p className="text-xs text-brand-muted mt-1">Page Cost: ₹{priceDetails.pageCost.toFixed(2)} + Base Fee: ₹{priceDetails.baseFee.toFixed(2)}</p>
        <p className="text-xs text-brand-muted mt-0.5">Base fee tier based on page cost. Double-sided costs 80% more per page.</p>
      </Card>

      <Button type="submit" size="lg" disabled={!selectedFile || !selectedShopId || isParsingPdf || effectivePagesToPrint <= 0 || effectiveCopies <= 0 || isLoadingShops} fullWidth>
        {isParsingPdf ? 'Processing File...' : 'Place Order & Proceed to Payment'}
      </Button>
    </form>
  );
};

export default FileUploadForm;
