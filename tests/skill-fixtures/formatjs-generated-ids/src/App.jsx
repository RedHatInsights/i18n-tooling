import { FormattedMessage } from "react-intl";

export function Greeting({ name, count }) {
  return (
    <section>
      <p><FormattedMessage defaultMessage="Welcome, {name}." values={{ name }} /></p>
      <p><FormattedMessage defaultMessage="{count, plural, one {# task} other {# tasks}} remain." values={{ count }} /></p>
    </section>
  );
}
