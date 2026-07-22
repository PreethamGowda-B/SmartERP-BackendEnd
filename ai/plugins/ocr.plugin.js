const BasePlugin = require("./base.plugin");
const OCRService = require("../../services/ocrService");

class OCRPlugin extends BasePlugin {
  constructor() {
    super("OCRPlugin", "Documents");

    // Tool: parse_invoice_document
    this.tools["parse_invoice_document"] = {
      name: "parse_invoice_document",
      description: "Parses raw text or OCR content from an uploaded vendor bill or receipt into structured SmartERP invoice data.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          documentText: { type: "string", description: "Raw text content extracted from receipt or invoice document" },
        },
        required: ["documentText"],
      },
      execute: async (params, context) => {
        return await OCRService.parseInvoiceDocument({
          documentText: params.documentText,
          companyId: context.user.companyId,
        });
      },
    };
  }
}

module.exports = OCRPlugin;
