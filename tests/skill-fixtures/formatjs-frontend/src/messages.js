import { defineMessages } from "react-intl";

export const messages = defineMessages({
  resultCount: {
    id: "results.count",
    defaultMessage: "{count, plural, one {# result}}",
    description: "Count of search results shown above the list."
  },
  billingPause: {
    id: "service.pause.billing",
    defaultMessage: "Stop the bill for service.",
    description: "Button shown before a service is deactivated."
  },
  resultEmpty: {
    id: "results.empty",
    defaultMessage: "No results match your filters."
  },
  saveSettings: {
    id: "settings.save",
    defaultMessage: "Save"
  },
  serviceStatus: {
    id: "service.status",
    defaultMessage: "Active"
  },
  clearFilters: {
    id: "filters.clear",
    defaultMessage: "Clear filters"
  }
});
