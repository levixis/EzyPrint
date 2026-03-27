
import React, { useState, useEffect } from 'react';
import { DocumentOrder, OrderStatus, PrintColor, UserType, OrderFile } from '../../types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { Input } from '../common/Input';
import { storage, storageRef, getDownloadURL, getBlob } from '../../firebase';
import { Spinner } from '../common/Spinner';
import { getOrderFiles } from '../../utils/orderHelpers';
import { downloadFileNative } from '../../utils/mobile';

interface ShopOrderDetailsModalProps {
  order: DocumentOrder;
  isOpen: boolean;
  onClose: () => void;
  updateOrderStatus: (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }) => Promise<DocumentOrder | undefined>;
}

const ShopOrderDetailsModal: React.FC<ShopOrderDetailsModalProps> = ({
  order,
  isOpen,
  onClose,
  updateOrderStatus,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus>(order.status);
  const [shopNotes, setShopNotes] = useState<string>(order.shopNotes || '');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingFileIndex, setDownloadingFileIndex] = useState<number | null>(null);
  const [isCheckingFiles, setIsCheckingFiles] = useState(false);

  const files = getOrderFiles(order);

  useEffect(() => {
    setSelectedStatus(order.status);
    setShopNotes(order.shopNotes || '');
    setDownloadError(null);
    setDownloadingFileIndex(null);

    if (isOpen) {
      // Check if first file is accessible
      const firstFile = files.find(f => f.fileStoragePath && !f.isFileDeleted);
      if (firstFile?.fileStoragePath) {
        setIsCheckingFiles(true);
        const fileReference = storageRef(storage, firstFile.fileStoragePath);
        getDownloadURL(fileReference)
          .then(() => setDownloadError(null))
          .catch((error) => {
            console.error("[ShopOrderDetailsModal] Error checking file:", error);
            setDownloadError("Some files may be unavailable.");
          })
          .finally(() => setIsCheckingFiles(false));
      } else {
        setIsCheckingFiles(false);
        if (files.every(f => f.isFileDeleted)) {
          setDownloadError("All files have been deleted per retention policy.");
        } else if (files.every(f => !f.fileStoragePath)) {
          setDownloadError("No file paths associated with this order.");
        }
      }
    }
  }, [order, isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusUpdate = async () => {
    await updateOrderStatus(order.id, selectedStatus, { shopNotes, actingUserType: UserType.SHOP_OWNER });
    onClose();
  };

  const handleDownloadFile = async (file: OrderFile, index: number) => {
    if (!file.fileStoragePath || file.isFileDeleted) {
      setDownloadError(`File "${file.fileName}" is not available.`);
      return;
    }
    setDownloadingFileIndex(index);
    setDownloadError(null);
    try {
      const fileReference = storageRef(storage, file.fileStoragePath);
      const rawBlob = await getBlob(fileReference);

      // Re-create blob with correct MIME type
      const mimeTypeMap: Record<string, string> = {
        'PDF': 'application/pdf',
        'DOCX': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'PPTX': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'TXT': 'text/plain',
        'JPEG': 'image/jpeg',
        'JPG': 'image/jpeg',
        'PNG': 'image/png',
        'WEBP': 'image/webp',
        'XLSX': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      const correctMimeType = mimeTypeMap[file.fileType.toUpperCase()] || rawBlob.type || 'application/octet-stream';
      const blob = new Blob([rawBlob], { type: correctMimeType });

      let downloadName = file.fileName || '';
      if (!downloadName && file.fileStoragePath) {
        const pathParts = file.fileStoragePath.split('/');
        downloadName = decodeURIComponent(pathParts[pathParts.length - 1] || 'download');
      }
      if (!downloadName) downloadName = 'download';

      // Use cross-platform download (native filesystem on mobile, blob URL on web)
      await downloadFileNative(blob, downloadName);
    } catch (error: unknown) {
      console.error("[ShopOrderDetailsModal] Error downloading file:", error);
      setDownloadError(`Download failed for "${file.fileName}": ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setDownloadingFileIndex(null);
    }
  };

  const handleDownloadAll = async () => {
    const downloadableFiles = files.filter(f => f.fileStoragePath && !f.isFileDeleted);
    for (let i = 0; i < downloadableFiles.length; i++) {
      const originalIndex = files.indexOf(downloadableFiles[i]);
      await handleDownloadFile(downloadableFiles[i], originalIndex);
      // Small delay between downloads to avoid browser blocking
      if (i < downloadableFiles.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  };

  const availableStatuses: { value: OrderStatus; label: string }[] = [
    { value: OrderStatus.PENDING_APPROVAL, label: 'Confirm Payment & Queue' },
    { value: OrderStatus.PRINTING, label: 'Printing In Progress' },
    { value: OrderStatus.READY_FOR_PICKUP, label: 'Ready for Pickup' },
    { value: OrderStatus.COMPLETED, label: 'Order Completed' },
    { value: OrderStatus.CANCELLED, label: 'Cancel Order' },
  ].filter(s => {
    if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) {
      return s.value === order.status;
    }
    if (order.status === OrderStatus.READY_FOR_PICKUP && (s.value === OrderStatus.PRINTING || s.value === OrderStatus.PENDING_APPROVAL)) {
      return false;
    }
    if (order.status === OrderStatus.PRINTING && s.value === OrderStatus.PENDING_APPROVAL) {
      return false;
    }
    if (s.value === OrderStatus.PENDING_PAYMENT || s.value === OrderStatus.PAYMENT_FAILED) {
      return false;
    }
    return true;
  });

  const downloadableFiles = files.filter(f => f.fileStoragePath && !f.isFileDeleted);
  const hasDownloadable = downloadableFiles.length > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Order Details: #${order.id.slice(-8)}`} size="lg">
      <div className="space-y-4 text-sm">

        {/* Files section */}
        <div className="bg-brand-secondaryLight/60 dark:bg-zinc-800/50 p-4 rounded-xl border border-brand-muted/30 dark:border-zinc-700">
          <div className="flex items-center justify-between mb-3">
            <h5 className="font-semibold text-brand-primary flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              Files ({files.length})
            </h5>
            {hasDownloadable && files.length > 1 && (
              <Button
                onClick={handleDownloadAll}
                variant="secondary"
                size="sm"
                disabled={downloadingFileIndex !== null}
              >
                Download All
              </Button>
            )}
          </div>

          {isCheckingFiles ? (
            <p className="text-gray-600 dark:text-gray-400 italic flex items-center">
              <Spinner size="sm" className="mr-2" /> Checking file availability...
            </p>
          ) : (
            <div className="space-y-2">
              {files.map((file, index) => (
                <div key={index} className="flex items-center gap-3 p-2 bg-white/50 dark:bg-zinc-900/30 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-brand-text dark:text-white truncate">{file.fileName}</p>
                    <p className="text-xs text-brand-lightText dark:text-gray-400">
                      {file.fileType} • {file.pageCount}pg × {file.copies}cp • {file.color === PrintColor.COLOR ? 'Color' : 'B&W'}{file.doubleSided ? ' • 2-sided' : ''}
                      {file.fileSizeBytes && ` • ${file.fileSizeBytes < 1024 * 100 ? (file.fileSizeBytes / 1024).toFixed(0) + ' KB' : (file.fileSizeBytes / (1024 * 1024)).toFixed(1) + ' MB'}`}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    file.color === PrintColor.COLOR
                      ? 'bg-gradient-to-r from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 text-purple-700 dark:text-purple-300'
                      : 'bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300'
                  }`}>
                    {file.color === PrintColor.COLOR ? 'Color' : 'B&W'}
                  </span>
                  {file.fileStoragePath && !file.isFileDeleted ? (
                    <button
                      onClick={() => handleDownloadFile(file, index)}
                      disabled={downloadingFileIndex !== null}
                      className="flex-shrink-0 p-1.5 text-brand-primary hover:bg-brand-primary/10 rounded-lg transition-colors disabled:opacity-50"
                      title={`Download ${file.fileName}`}
                    >
                      {downloadingFileIndex === index ? (
                        <Spinner size="sm" />
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                          <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                          <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                        </svg>
                      )}
                    </button>
                  ) : (
                    <span className="text-xs text-brand-muted italic">Deleted</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {downloadError && (
          <p className="text-sm text-status-error bg-red-700/20 p-2 rounded-lg">{downloadError}</p>
        )}

        <p><strong>Student ID:</strong> {order.userId.slice(-10)}</p>
        <p><strong>Uploaded:</strong> {new Date(order.uploadedAt).toLocaleString()}</p>

        <div className="bg-brand-secondaryLight/60 p-3 rounded-lg border border-brand-muted/30">
          <h5 className="font-semibold text-brand-primary mb-1">Print Summary:</h5>
          <ul className="list-disc list-inside text-xs space-y-0.5 text-gray-600 dark:text-gray-400">
            <li>Total Pages: {order.printOptions.pages}</li>
            <li>Files: {files.length} (settings per file shown above)</li>
          </ul>
        </div>
        <div className="bg-brand-secondaryLight/60 p-3 rounded-lg border border-brand-muted/30">
          <h5 className="font-semibold text-brand-primary mb-1">Pricing Details:</h5>
          <div className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
            <div className="flex justify-between"><span>Page Cost:</span> <span>₹{order.priceDetails.pageCost.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Base Fee:</span> <span>₹{order.priceDetails.baseFee.toFixed(2)}</span></div>
            <hr className="my-1 border-brand-muted/50" />
            <div className="flex justify-between font-semibold"><span>Total Order Value:</span> <span>₹{order.priceDetails.totalPrice.toFixed(2)}</span></div>
          </div>
        </div>


        {order.status === OrderStatus.READY_FOR_PICKUP && order.pickupCode && (
          <div className="mt-2 p-3 bg-status-success/20 rounded-lg border border-status-success">
            <p className="text-status-success">Pickup Code: <strong className="text-xl text-white tracking-wider bg-brand-primary px-2 py-0.5 rounded">{order.pickupCode}</strong></p>
          </div>
        )}

        <Input
          label="Shop Notes (visible to student)"
          id="shopNotesModal"
          type="textarea"
          value={shopNotes}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setShopNotes(e.target.value)}
          placeholder="e.g., Print quality check complete."
          className="mt-2"
          rows={3}
          disabled={order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED}
        />

        <Select
          label="Update Order Status"
          id="statusUpdateModal"
          options={availableStatuses}
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value as OrderStatus)}
          containerClassName="mt-4"
          disabled={order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED}
        />
        <Button onClick={handleStatusUpdate} fullWidth className="mt-6" disabled={(selectedStatus === order.status && shopNotes === (order.shopNotes || '')) || order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED}>
          {order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED ? 'Order Finalized' : 'Confirm & Update Status'}
        </Button>
      </div>
    </Modal>
  );
};

export default ShopOrderDetailsModal;
