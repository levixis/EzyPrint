
import React, { useState, useEffect } from 'react';
import { DocumentOrder, OrderStatus, PrintColor, UserType } from '../../types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { Input } from '../common/Input';
import { storage, storageRef, getDownloadURL } from '../../firebase'; 
import { Spinner } from '../common/Spinner';

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
  
  const [isFetchingInitialDownloadUrl, setIsFetchingInitialDownloadUrl] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  
  // We don't store the direct downloadUrl anymore, we'll fetch it on demand for actual download.

  useEffect(() => {
    setSelectedStatus(order.status);
    setShopNotes(order.shopNotes || '');
    setDownloadError(null);
    setIsPreparingDownload(false); // Reset download prep state

    if (isOpen && order.fileStoragePath && !order.isFileDeleted) {
      // Check if file is accessible (optional initial check, actual download fetches again)
      setIsFetchingInitialDownloadUrl(true);
      const fileReference = storageRef(storage, order.fileStoragePath);
      getDownloadURL(fileReference)
        .then(() => {
          setDownloadError(null); // File seems accessible
        })
        .catch((error) => {
          console.error("[ShopOrderDetailsModal] Error initially checking download URL:", error);
          setDownloadError("Could not retrieve file information. File may be unavailable or permissions might be insufficient.");
        })
        .finally(() => {
          setIsFetchingInitialDownloadUrl(false);
        });
    } else {
       setIsFetchingInitialDownloadUrl(false);
       if (isOpen && order.isFileDeleted) {
           setDownloadError("The source file has been deleted as per retention policy.");
       } else if (isOpen && !order.fileStoragePath) {
           setDownloadError("No file path associated with this order.");
       }
    }
  }, [order, isOpen]);

  const handleStatusUpdate = async () => {
    await updateOrderStatus(order.id, selectedStatus, { shopNotes, actingUserType: UserType.SHOP_OWNER });
    onClose();
  };
  
  const handleDownloadFile = async () => {
    if (!order.fileStoragePath || order.isFileDeleted) {
      setDownloadError("File is not available for download.");
      return;
    }
    setIsPreparingDownload(true);
    setDownloadError(null);
    try {
      const fileReference = storageRef(storage, order.fileStoragePath);
      const url = await getDownloadURL(fileReference);
      
      // Fetch the file as a blob
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }
      const blob = await response.blob();
      
      // Create a temporary link and trigger download
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.setAttribute('download', order.fileName || 'download'); // Set the download attribute
      document.body.appendChild(link);
      link.click();
      
      // Clean up
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
      
    } catch (error: any) {
      console.error("[ShopOrderDetailsModal] Error downloading file:", error);
      setDownloadError(`Download failed: ${error.message || "Unknown error"}`);
    } finally {
      setIsPreparingDownload(false);
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
      if (order.status === OrderStatus.READY_FOR_PICKUP && (s.value === OrderStatus.PRINTING || s.value === OrderStatus.PENDING_APPROVAL)){
        return false;
      }
      if (order.status === OrderStatus.PRINTING && s.value === OrderStatus.PENDING_APPROVAL){
        return false;
      }
      if (s.value === OrderStatus.PENDING_PAYMENT || s.value === OrderStatus.PAYMENT_FAILED) {
        return false;
      }
      return true;
  });

  const canDownload = order.fileStoragePath && !order.isFileDeleted;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Order Details: #${order.id.slice(-8)}`} size="lg">
      <div className="space-y-4 text-sm">
        <p><strong>File:</strong> {order.fileName} ({order.fileType})</p>

        {isFetchingInitialDownloadUrl ? (
          <p className="text-brand-lightText italic flex items-center">
            <Spinner size="sm" className="mr-2"/> Checking file availability...
          </p>
        ) : canDownload ? (
          <Button
            onClick={handleDownloadFile}
            variant="primary"
            size="sm"
            disabled={isPreparingDownload}
            leftIcon={isPreparingDownload ? <Spinner size="sm" color="text-white"/> : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" /><path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" /></svg>}
            className="inline-flex items-center"
          >
            {isPreparingDownload ? 'Preparing...' : 'Download File'}
             {!isPreparingDownload && <span className="font-normal ml-1">({order.fileSizeBytes ? (order.fileSizeBytes / (1024 * 1024) < 0.1 ? (order.fileSizeBytes / 1024).toFixed(1) + ' KB' : (order.fileSizeBytes / (1024*1024)).toFixed(2) + ' MB') : 'Size N/A'})</span>}
          </Button>
        ) : (
           <p className="text-brand-muted p-2 bg-brand-secondaryLight rounded-md border border-brand-muted/50">
             {downloadError || "File not available for download."}
           </p>
        )}
         {downloadError && !isFetchingInitialDownloadUrl && !isPreparingDownload && (
            <p className="text-sm text-status-error mt-1">{downloadError}</p>
         )}


        <p><strong>Student ID:</strong> {order.userId.slice(-10)}</p>
        <p><strong>Uploaded:</strong> {new Date(order.uploadedAt).toLocaleString()}</p>

         <div className="bg-brand-secondaryLight/60 p-3 rounded-lg border border-brand-muted/30">
            <h5 className="font-semibold text-brand-primary mb-1">Print Options:</h5>
            <ul className="list-disc list-inside text-xs space-y-0.5 text-brand-lightText">
                <li>Copies: {order.printOptions.copies}</li>
                <li>Pages: {order.printOptions.pages}</li>
                <li>Color: {order.printOptions.color === PrintColor.COLOR ? 'Color' : 'Black & White'}</li>
                <li>Sided: {order.printOptions.doubleSided ? 'Double-sided' : 'Single-sided'}</li>
            </ul>
        </div>
        <div className="bg-brand-secondaryLight/60 p-3 rounded-lg border border-brand-muted/30">
            <h5 className="font-semibold text-brand-primary mb-1">Pricing Details:</h5>
            <div className="text-xs text-brand-lightText space-y-0.5">
                <div className="flex justify-between"><span>Page Cost:</span> <span>₹{order.priceDetails.pageCost.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>Base Fee:</span> <span>₹{order.priceDetails.baseFee.toFixed(2)}</span></div>
                <hr className="my-1 border-brand-muted/50"/>
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
