import { FormattedMessage } from "react-intl";
import { messages } from "./messages.js";

export function ServiceControls() {
  return (
    <section>
      <p><FormattedMessage {...messages.serviceStatus} /></p>
      {/* Billing policy differs by service; confirm the intended promise before changing this label. */}
      <button><FormattedMessage {...messages.billingPause} /></button>
      <button><FormattedMessage {...messages.saveSettings} /></button>
    </section>
  );
}
