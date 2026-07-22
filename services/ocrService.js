const ProviderFactory = require("../ai/providers/provider.factory");

class OCRService {
  /**
   * Parses invoice/receipt text content using AI extraction.
   * @param {Object} params
   * @param {string} params.documentText - Raw text or OCR string from uploaded document
   * @param {string} params.companyId - Tenant Scope
   */
  static async parseInvoiceDocument({ documentText, companyId }) {
    if (!documentText || typeof documentText !== "string") {
      throw new Error("Document text is required for OCR parsing.");
    }

    const provider = ProviderFactory.getProvider();

    const systemPrompt = `
You are an expert Document & Invoice OCR Parsing Engine for SmartERP.
Extract the structured JSON invoice data from the provided raw invoice text.

Return ONLY a JSON object matching this schema:
{
  "vendorName": "Vendor or Supplier Company Name",
  "invoiceNumber": "Invoice ID or Number",
  "invoiceDate": "YYYY-MM-DD",
  "totalAmount": 12500.00,
  "currency": "INR",
  "gstin": "GSTIN or Tax ID if present",
  "lineItems": [
    { "description": "Item description", "quantity": 2, "unitPrice": 5000.00, "total": 10000.00 }
  ]
}
`.trim();

    const completion = await provider.generateCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Extract invoice data from this text:\n\n${documentText.slice(0, 3000)}` },
      ],
      temperature: 0.1,
    });

    let parsed = {};
    try {
      const jsonMatch = completion.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.warn("⚠️ OCR JSON parsing warning:", err.message);
    }

    return {
      success: true,
      companyId,
      parsedData: {
        vendorName: parsed.vendorName || "Unknown Vendor",
        invoiceNumber: parsed.invoiceNumber || `INV-${Date.now()}`,
        invoiceDate: parsed.invoiceDate || new Date().toISOString().split("T")[0],
        totalAmount: parseFloat(parsed.totalAmount || 0),
        currency: parsed.currency || "INR",
        gstin: parsed.gstin || "N/A",
        lineItems: parsed.lineItems || [],
      },
    };
  }
}

module.exports = OCRService;
