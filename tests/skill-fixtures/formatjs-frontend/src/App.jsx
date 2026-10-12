import { FormattedMessage } from "react-intl";
import { messages } from "./messages.js";

export function Results({ count }) {
  return (
    <section>
      <h1><FormattedMessage {...messages.resultCount} values={{ count }} /></h1>
      <p><FormattedMessage {...messages.resultEmpty} /></p>
      <button><FormattedMessage {...messages.clearFilters} /></button>
    </section>
  );
}
