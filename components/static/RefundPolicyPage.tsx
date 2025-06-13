
import React from 'react';
import { Card } from '../common/Card';

const RefundPolicyPage: React.FC = () => {
  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <Card title="Cancellation and Refund Policy" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-4">
          <p><strong>Last Updated: {new Date().toLocaleDateString()}</strong></p>

          <h2 className="text-brand-primary">1. Order Cancellation</h2>
          <p><strong>By Student:</strong></p>
          <ul>
            <li>Orders can be cancelled by the student if the payment has not yet been made (status "Pending Payment").</li>
            <li>Once payment is made and the order status moves to "Pending Approval" or "Printing," cancellation by the student may not be possible or may be subject to policies of the individual print shop. Contact the print shop directly or EzyPrint support.</li>
          </ul>
          <p><strong>By Shop Owner:</strong></p>
          <ul>
            <li>Shop owners may cancel an order under certain circumstances (e.g., inability to fulfill the print job as specified, issues with the uploaded file, violation of terms).</li>
            <li>If a shop owner cancels an order after payment has been made, a full refund will typically be processed for the student.</li>
          </ul>
           <p><strong>By EzyPrint:</strong></p>
          <ul>
            <li>EzyPrint reserves the right to cancel any order if there is a violation of our Terms and Conditions, suspected fraudulent activity, or other critical issues.</li>
          </ul>


          <h2 className="text-brand-primary">2. Refund Policy</h2>
          <p>Refunds will be processed under the following conditions:</p>
          <ul>
            <li><strong>Order Cancellation by Shop or EzyPrint:</strong> If an order is cancelled by the print shop or EzyPrint after the student has made payment, a full refund of the total amount paid will be issued to the student's original payment method.</li>
            <li><strong>Print Quality Issues:</strong> If there are significant defects in the print quality (e.g., smudging, incorrect colors not attributable to file issues, missing pages) attributable to the print shop, students should contact the print shop directly within [e.g., 24-48 hours] of pickup with photographic evidence.
                <ul>
                    <li>The print shop will assess the issue. If the fault lies with the shop, they may offer a reprint or EzyPrint may facilitate a partial or full refund upon confirmation from the shop.</li>
                </ul>
            </li>
            <li><strong>Incorrect Order Fulfilled:</strong> If the student receives an order that does not match their confirmed print options (e.g., wrong number of copies, incorrect paper type if specified and offered), they should report it to the print shop or EzyPrint support.</li>
          </ul>
          <p><strong>Non-Refundable Situations:</strong></p>
          <ul>
            <li>Errors in the uploaded document provided by the student (e.g., typos, low-resolution images, incorrect formatting).</li>
            <li>Student changing their mind after the print job has been processed.</li>
            <li>Delays in pickup by the student once the order is "Ready for Pickup."</li>
          </ul>

          <h2 className="text-brand-primary">3. Refund Process</h2>
          <ul>
            <li>To request a refund, please contact EzyPrint support via the "Contact Us" page or [Your Support Email Address], providing your order ID and a clear description of the issue.</li>
            <li>Refunds, once approved, will be processed within [e.g., 7-10 business days] to the original method of payment. Processing times may vary depending on your bank or payment provider.</li>
          </ul>

          <h2 className="text-brand-primary">4. Base Fee</h2>
          <p>EzyPrint's base fee is generally non-refundable unless the order is cancelled by EzyPrint or the Shop before any significant processing, or in cases of complete non-delivery of service attributable to EzyPrint or the Shop.</p>
          
          <h2 className="text-brand-primary">5. Contact</h2>
          <p>For any questions regarding cancellations or refunds, please contact us.</p>
          <p className="italic text-brand-muted">This is a template. Please replace with your own comprehensive Cancellation and Refund Policy reviewed by a legal professional, considering specific operational details and consumer rights.</p>
        </div>
      </Card>
    </div>
  );
};

export default RefundPolicyPage;
