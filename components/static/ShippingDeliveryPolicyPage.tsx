
import React from 'react';
import { Card } from '../common/Card';

const ShippingDeliveryPolicyPage: React.FC = () => {
  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <Card title="Service Delivery Policy" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-4">
          <p><strong>Last Updated: {new Date().toLocaleDateString()}</strong></p>

          <h2 className="text-brand-primary">1. Service Scope</h2>
          <p>EzyPrint facilitates print order services. The "delivery" of the service refers to the completion of the print job by the selected print shop and making it available for pickup by the student.</p>
          <p><strong>EzyPrint does not offer physical shipping or delivery of printed materials to the student's address.</strong> All orders are to be picked up by the student from the respective print shop's physical location.</p>

          <h2 className="text-brand-primary">2. Order Processing Time</h2>
          <ul>
            <li>Once a student's payment is confirmed and the order status moves to "Pending Approval," the selected print shop will begin processing the order.</li>
            <li>Processing times may vary depending on the complexity of the print job, the volume of orders at the shop, and the shop's operating hours.</li>
            <li>Estimated processing times might be indicated by the shop, but these are not guaranteed. Students will be notified when their order status changes to "Printing" and then "Ready for Pickup."</li>
          </ul>

          <h2 className="text-brand-primary">3. Notification of Readiness</h2>
          <ul>
            <li>Students will receive a notification through the EzyPrint application (and potentially via email, if configured) when their order is "Ready for Pickup."</li>
            <li>The notification will include a unique Pickup Code. This code must be presented to the print shop staff to collect the order.</li>
          </ul>

          <h2 className="text-brand-primary">4. Order Pickup</h2>
          <ul>
            <li>Students are responsible for picking up their orders from the print shop they selected during the order process.</li>
            <li>The print shop's address is available within the EzyPrint application.</li>
            <li>Students should pick up their orders within a reasonable timeframe (e.g., [e.g., 7 days]) after receiving the "Ready for Pickup" notification. Shops may have their own policies regarding unclaimed orders.</li>
            <li>Valid identification along with the Pickup Code may be required by the print shop.</li>
          </ul>
          
          <h2 className="text-brand-primary">5. Shop Operating Hours</h2>
          <p>Students should check the operating hours of the selected print shop before going for pickup. EzyPrint endeavors to display shop open/closed status, but it is the student's responsibility to verify pickup times.</p>

          <h2 className="text-brand-primary">6. Issues with Pickup</h2>
          <p>If a student encounters any issues during pickup (e.g., shop closed during stated hours, order not found despite notification), they should first try to resolve it with the print shop staff. If unresolved, contact EzyPrint support for assistance.</p>
          
          <h2 className="text-brand-primary">7. Contact</h2>
          <p>For any questions regarding service delivery or pickup, please contact the respective print shop or EzyPrint support.</p>
          <p className="italic text-brand-muted">This is a template. Please adapt it to accurately reflect your service model. Ensure clarity that this is a pickup-only service.</p>
        </div>
      </Card>
    </div>
  );
};

export default ShippingDeliveryPolicyPage;
