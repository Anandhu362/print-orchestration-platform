import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { PDFDocument } from 'pdf-lib';
import { pdfToPng } from 'pdf-to-png-converter';

const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export type CommercialJobCategory = 
  | 'FLYER' 
  | 'VISITING_CARD' 
  | 'STICKER' 
  | 'DANGLER' 
  | 'PUSH_PULL' 
  | 'COUPON' 
  | 'VINYL' 
  | 'BOARD' 
  | 'ROLLUP' 
  | 'OTHER';

export interface ExtractedPrintSpec {
  jobCategory?: CommercialJobCategory;
  shopName: string;
  workDetails: string;
  pageCount: number;
  quantity: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export function isPageBurstFilename(fileName: string): boolean {
  if (!fileName) return false;
  const clean = fileName.trim().toLowerCase();
  return (
    /(^\d+(st|nd|rd|th)?[\s_-]*(page|pg|p)\b)|(\b(page|pg|p)[\s_-]*\d+)/i.test(clean) ||
    /^(back|inside|front|cover|outer|inner)[\s_-]*(page)?\b/i.test(clean)
  );
}

const GENERIC_FILENAME_BLACKLIST = /^(www|web|site|final|print|page|pdf|file|doc|document|unnamed|scan|image|super|sale|promo|flayer|flyer|catalog|catalogue|offer|offers|copy|copies|draft|test|new|temp)\b/i;

export function cleanGenericFilename(fileName: string): string | null {
  if (!fileName) return null;
  const cleanName = fileName.replace(/\.[^/.]+$/, '').trim();
  if (isPageBurstFilename(cleanName)) return null;

  let cleaned = cleanName
    .replace(/(promo|flayer|flyer|catalog|catalogue|offer|offers|super|sale)/gi, ' ')
    .replace(/\b(final|print|page|doc|document|pdf|copy|copies|draft|temp|new|outlines?)\b/gi, ' ')
    .replace(/(sep|september|oct|october|nov|november|dec|december|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august)\b/gi, ' ')
    .replace(/\b\d{1,2}\s*(to|-)\s*\d{1,2}\b/gi, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 3 && !GENERIC_FILENAME_BLACKLIST.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return null;
}

export async function renderPdfPage1ToPng(pdfBuffer: Buffer): Promise<Buffer | null> {
  if (!pdfBuffer || pdfBuffer.length === 0) return null;
  try {
    const pngPages = await pdfToPng(pdfBuffer, {
      pagesToProcess: [1],
      viewportScale: 1.5
    });
    if (pngPages && pngPages.length > 0 && pngPages[0].content) {
      return Buffer.from(pngPages[0].content);
    }
    return null;
  } catch (err: any) {
    console.warn('[PDF RENDER] Failed to render Page 1:', err?.message);
    return null;
  }
}

export async function extractPdfMetadata(buffer: Buffer): Promise<{ title?: string; pageCount: number }> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const title = doc.getTitle();
    const pageCount = doc.getPageCount();
    return {
      title: title && title.trim().length >= 3 ? title.trim() : undefined,
      pageCount: pageCount || 1
    };
  } catch {
    return { pageCount: 1 };
  }
}

export function extractSpecsWithRegex(
  text?: string,
  fileName?: string
): {
  jobCategory?: CommercialJobCategory;
  workDetails?: string;
  quantity?: number;
  pageCount?: number;
  extractedDimension?: string;
  isNumbering?: boolean;
} {
  const textClean = (text || '').replace(/,/g, ' ').trim();
  const fileClean = (fileName || '')
    .replace(/\.[a-zA-Z0-9]+$/g, '')
    .replace(/[_\-\.]+/g, ' ')
    .trim();
  const combined = `${textClean} ${fileClean}`.trim();

  if (!combined) return {};

  let jobCategory: CommercialJobCategory | undefined;
  let workDetails: string | undefined;
  let quantity: number | undefined;
  let pageCount: number | undefined;

  const isBothSide = /both\s*sides?|\b2\s*sides?\b/i.test(combined);
  const isSingleSide = /single\s*sides?|\b1\s*side\b/i.test(combined);
  const isNumbering = /\b(?:with\s*)?numberings?\b/i.test(combined);

  const isCoupon = /\b(?:coupon|coupen|cupon|voucher|raffle|ticket|token)s?\b/i.test(combined) || 
                   /\blucky\s*draw\b/i.test(combined);
  const isVisitingCard = /(?:visiting|visting|business)\s*cards?|\bvc\b|\bname\s*cards?\b/i.test(combined);
  const isPushPull = /\bpush\s*(?:&|and)?\s*pull\b|\bdoor\s*stickers?\b/i.test(combined);
  const isDangler = /\b(?:dangler|danglker|hanging\s*cards?|die\s*cut\s*dangler)s?\b/i.test(combined);
  const isVinyl = /\b(?:vinyl|vinayl|vynil|one\s*way\s*vision|frosted\s*vinyl)\b/i.test(combined);
  const isBoard = /\b(?:foam\s*board|forex\s*board|acrylic\s*board|sign\s*board|signage|corrugated\s*board|\bboards?)\b/i.test(combined);
  const isRollup = /\b(?:roll\s*up|rollup|pull\s*up\s*banner|standee)\b/i.test(combined);
  const isSticker = /\b(?:delivery\s*stickers?|roll\s*stickers?|die\s*cut\s*stickers?|stickers?|stckers?|labels?|decals?)\b/i.test(combined);
  const isOfferPaperOrFlyer = /\b(?:offer\s*p(?:ap|ay)er|flayer|flyer|pamphlet|leaflet)s?\b/i.test(combined);

  const dimMatch = textClean.match(/(\d{1,4}\s*[/xX]\s*\d{1,4})/i) || combined.match(/(\d{1,4}\s*[/xX]\s*\d{1,4})/i);
  const extractedDimension = dimMatch ? dimMatch[1].replace(/\s+/g, '').toUpperCase() : undefined;
  const dimPrefix = extractedDimension ? `${extractedDimension} ` : '';

  if (isVisitingCard) {
    jobCategory = 'VISITING_CARD';
    workDetails = isBothSide ? 'VISITING CARD BOTH SIDE' : (isSingleSide ? 'VISITING CARD SINGLE SIDE' : 'VISITING CARD');
  } else if (isCoupon) {
    jobCategory = 'COUPON';
    workDetails = isNumbering 
      ? `${dimPrefix}COUPON WITH NUMBERING` 
      : (extractedDimension ? `${dimPrefix}COUPON` : (isNumbering ? 'COUPON WITH NUMBERING' : 'COUPON'));
  } else if (isPushPull) {
    jobCategory = 'PUSH_PULL';
    workDetails = 'PUSH & PULL STICKER';
  } else if (isDangler) {
    jobCategory = 'DANGLER';
    workDetails = extractedDimension ? `${dimPrefix}DANGLER` : 'DANGLER';
  } else if (isVinyl) {
    jobCategory = 'VINYL';
    workDetails = extractedDimension ? `${dimPrefix}VINYL` : 'VINYL PRINT';
  } else if (isBoard) {
    jobCategory = 'BOARD';
    workDetails = extractedDimension ? `${dimPrefix}BOARD` : 'FOAM BOARD';
  } else if (isRollup) {
    jobCategory = 'ROLLUP';
    workDetails = extractedDimension ? `${dimPrefix}ROLL UP BANNER` : 'ROLL UP BANNER';
  } else if (isSticker) {
    jobCategory = 'STICKER';
    workDetails = extractedDimension ? `${dimPrefix}STICKER` : 'STICKER';
  } else if (/\b(A[2-5])\s*TO\s*(A[3-6])\b/i.test(combined)) {
    jobCategory = 'FLYER';
    const foldMatch = combined.match(/\b(A[2-5])\s*TO\s*(A[3-6])\b/i)!;
    workDetails = `${foldMatch[1].toUpperCase()} TO ${foldMatch[2].toUpperCase()}`;
  } else if (/23\s*[/xX]\s*33/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = '23X33';
  } else if (/22\s*[/xX]\s*33/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = '22X33';
  } else if (/\bA3\b/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = isBothSide ? 'A3 Both side' : (isSingleSide ? 'A3 Single side' : 'A3');
  } else if (/\bA4\b|A4SIZE/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = isBothSide ? 'A4 Both side' : (isSingleSide ? 'A4 Single side' : 'A4');
  } else if (/\bA2\b/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = isBothSide ? 'A2 Both side' : (isSingleSide ? 'A2 Single side' : 'A2');
  } else if (/\bA5\b/i.test(combined)) {
    jobCategory = 'FLYER';
    workDetails = isBothSide ? 'A5 Both side' : (isSingleSide ? 'A5 Single side' : 'A5');
  } else if (isOfferPaperOrFlyer) {
    jobCategory = 'FLYER';
    workDetails = extractedDimension || (isBothSide ? 'Both side' : 'A4');
  } else if (extractedDimension) {
    jobCategory = 'STICKER';
    workDetails = `${extractedDimension} STICKER`;
  }

  const qtyMatch = combined.match(/(\d{1,7})\s*(?:copy|copies|q|qty|count|nos|no|pcs|pc|piece|pieces|sets)\b/i) ||
                   combined.match(/\b(?:qty|quantity)\s*[:=]?\s*(\d{1,7})\b/i);
  if (qtyMatch) {
    quantity = parseInt(qtyMatch[1], 10);
  }

  const pageMatch = combined.match(/(\d{1,3})\s*(?:page|pages|p)\b/i);
  if (pageMatch) {
    pageCount = parseInt(pageMatch[1], 10);
  }

  return { jobCategory, workDetails, quantity, pageCount, extractedDimension, isNumbering };
}

export async function parseAdsproMultimodalJob(input: {
  imageBuffer?: Buffer;
  specText: string;
  fileNames: string[];
  declaredPageCount?: number;
  pdfTitle?: string;
}): Promise<ExtractedPrintSpec> {
  const { imageBuffer, specText, fileNames, declaredPageCount, pdfTitle } = input;
  const primaryFileName = fileNames[0] || '';

  const regexSpecs = extractSpecsWithRegex(specText, primaryFileName);
  let resolvedCategory: CommercialJobCategory = regexSpecs.jobCategory || 'FLYER';
  let resolvedShopName: string | null = null;
  let resolvedWorkDetails: string = regexSpecs.workDetails || '';
  let resolvedQuantity: number = regexSpecs.quantity || 0;
  let resolvedPageCount: number = declaredPageCount || regexSpecs.pageCount || 1;

  if (imageBuffer && imageBuffer.length > 0) {
    try {
      const model = ai.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: `You are an expert commercial print order analyst for UAE commercial printing presses.
Classify the commercial print category and extract exact specifications in ONE SINGLE PASS.

1. CATEGORY: FLYER (Supermarket / Retail Promotional Catalogs, Folders & Papers)
   - Visual Clues: Multi-page or full A4/A3 offer papers, grocery/electronics discount items with prices. Customer text may say "flyer", "flayer", "offer paper", "offer payer".
   - Distinctive Store Brand (brandName): Extract distinctive brand (e.g. FURQAN, RUMAN, WADI, DAILY EXPRESS, GO FRESH, BEST HOME). Omit generic umbrella terms ("AL MADINA", "SUPERMARKET", "HYPERMARKET") if a distinctive prefix brand exists.
   - Mandatory Branch Location (branchLocation): Inspect bottom banner (e.g. DIP 2, JABEL ALI 1, BUR DUBAI, KHWANEEJ 2, QUSAIS, MUHAISNAH).
   - fullShopName: "[BRAND] [BRANCH_LOCATION]" in uppercase.
   - workDetails (CRITICAL FOR AUDITING & PRICING):
     * Size Transformations & Folded Booklets: If customer caption specifies a folding or conversion specification (e.g. "A3 TO A4", "A2 TO A3", "A4 TO A5"), you MUST output the exact transformation format "A3 TO A4", "A2 TO A3", or "A4 TO A5". NEVER truncate it to a single flat size ("A3" or "A4")!
     * Standard Offset Sheet Sizes: "23X33", "22X33".
     * Flat Leaflet Sizes: "A4", "A3", "A2", "A5" (append "Both side" or "Single side" if specified, e.g. "A4 Both side").
     * STRICT FORMATTING RULE: NEVER append the generic word "FLYER" or "FLAYER" to workDetails (e.g. output "A3 TO A4" or "A4", NEVER "A3 FLYER" or "A4 FLYER").
   - Strict Flyer Rule: If brand or branch location is missing/unreadable, output "NOT_FOUND".

2. CATEGORY: VISITING_CARD (Business Cards, Name Cards, Corporate Cards)
   - Visual Clues: Small card aspect ratio (~9x5.4cm), corporate logos, personal names, telephone/email icons. WhatsApp caption contains "visiting card", "business card", "visting card", "vc".
   - Client / Company Name (brandName): Extract prominent company/trade name or cardholder name (e.g. "AJSAL").
   - Branch Location (branchLocation): Return empty string "".
   - fullShopName: Clean Company or Person Name in uppercase.
   - workDetails: Standardize to "VISITING CARD" (or "VISITING CARD BOTH SIDE" if 2 pages / both side indicated).

3. CATEGORY: STICKER (Delivery Stickers, Packaging Decals, Product Labels, Die-Cut Vinyl)
   - Visual Clues: Product or packaging stickers, round or rectangular decals. Captions often contain "sticker", "stcker", "delivery sticker", "roll sticker", "15x10", "10x10".
   - Client / Store Name (brandName): Store brand, restaurant, or business name (e.g. "WADI MARKET", "AL MADINA").
   - Branch Location (branchLocation): Area if present, else empty string "".
   - fullShopName: "[BRAND] [BRANCH_LOCATION]" if branch is present; otherwise clean "[BRAND]".
   - workDetails: MUST ALWAYS format as Dimension + "STICKER" (e.g. "15X10 STICKER", "DELIVERY STICKER", "ROLL STICKER", "STICKER"). NEVER output just the dimension alone like "15X10"!

4. CATEGORY: COUPON (Lucky Draw Coupons, Raffle Tickets, Discount Vouchers, Entry Passes)
   - Visual Clues: Tickets or coupons with customer stub/counterfoil ("Name:", "Address:", "Tel:", "No:"), lucky draw headline ("LUCKY DRAW", "WIN A CAR"), sequential ticket numbering boxes.
   - CRITICAL DISTINCTION: Coupons are NEVER STICKERS. Do NOT classify a lucky draw ticket or raffle voucher as STICKER.
   - fullShopName: Store brand or organizer name.
   - workDetails: Dimension + "COUPON" (e.g. "16X7 COUPON"), and if caption or artwork specifies numbering, format as "[DIMENSION] COUPON WITH NUMBERING" (e.g. "16X7 COUPON WITH NUMBERING").

5. CATEGORY: DANGLER (Store Ceiling / Shelf Hanging POSM Cards)
   - workDetails: "DANGLER", "DIE CUT DANGLER", or "[DIMENSION] DANGLER".

6. CATEGORY: PUSH_PULL (Door Entrance & Exit Glass Stickers)
   - workDetails: "PUSH & PULL STICKER".

7. CATEGORY: VINYL (Large-Format Prints, Vehicle Branding, Frosted Glass, One-Way Vision)
   - workDetails: "[DIMENSION] VINYL" (e.g. "100X200 VINYL"), "[DIMENSION] FROSTED VINYL", or "VINYL PRINT".

8. CATEGORY: BOARD (Signboards, Foam Boards, Forex Boards, Acrylic Boards, Display Signages)
   - workDetails: "[DIMENSION] FOAM BOARD", "[DIMENSION] FOREX BOARD", "[DIMENSION] SIGN BOARD", or "[DIMENSION] BOARD" (e.g. "60X90 FOAM BOARD").

9. CATEGORY: ROLLUP (Retractable Pull-Up Display Standees)
   - workDetails: "[DIMENSION] ROLL UP BANNER" (e.g. "85X200 ROLL UP BANNER") or "ROLL UP BANNER".

10. CATEGORY: OTHER (Brochures, Letterheads, Envelopes, Invoices, Bill Books, Posters)
    - Extract client/brand name and specific format.`,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              jobCategory: {
                type: SchemaType.STRING,
                format: 'enum',
                enum: ['FLYER', 'VISITING_CARD', 'STICKER', 'DANGLER', 'PUSH_PULL', 'COUPON', 'VINYL', 'BOARD', 'ROLLUP', 'OTHER'],
                description: 'Classified commercial print category'
              },
              brandName: { type: SchemaType.STRING, description: 'Brand, company, or person name or NOT_FOUND' },
              branchLocation: { type: SchemaType.STRING, description: 'Branch location for flyers, or empty string' },
              fullShopName: { type: SchemaType.STRING, description: 'Final clean Shop/Client Name or NOT_FOUND' },
              workDetails: { 
                type: SchemaType.STRING, 
                description: 'Format e.g. A3 TO A4, A2 TO A3, 23X33, A4, A3, VISITING CARD, 15X10 STICKER, DELIVERY STICKER, 16X7 COUPON WITH NUMBERING, 60X90 FOAM BOARD, 100X200 VINYL, 85X200 ROLL UP BANNER' 
              },
              quantity: { type: SchemaType.NUMBER, description: 'Print copy quantity' },
              pageCount: { type: SchemaType.NUMBER, description: 'Page count' }
            },
            required: ['jobCategory', 'brandName', 'fullShopName', 'workDetails', 'quantity', 'pageCount']
          }
        }
      });

      const prompt = `Analyze this commercial print document cover and customer WhatsApp order.
Document Filename: "${primaryFileName}"
${pdfTitle ? `Title: "${pdfTitle}"\n` : ''}

<untrusted_customer_order_message>
${specText}
</untrusted_customer_order_message>`;

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/png'
          }
        }
      ]);

      const parsed = JSON.parse(result.response.text().trim());
      resolvedCategory = parsed.jobCategory || resolvedCategory;

      const brand = parsed.brandName?.trim() || '';
      const location = parsed.branchLocation?.trim() || '';
      const fullShop = parsed.fullShopName?.trim() || '';

      if (fullShop && fullShop !== 'NOT_FOUND') {
        resolvedShopName = fullShop.toUpperCase();
      } else if (brand && brand !== 'NOT_FOUND') {
        resolvedShopName = location ? `${brand} ${location}`.toUpperCase() : brand.toUpperCase();
      }

      if (parsed.workDetails) {
        resolvedWorkDetails = parsed.workDetails;
      }
      if (!resolvedQuantity && parsed.quantity) {
        resolvedQuantity = parsed.quantity;
      }
      if (parsed.pageCount && !declaredPageCount) {
        resolvedPageCount = parsed.pageCount;
      }
    } catch (err: any) {
      console.warn('[AI EXTRACTION] Multimodal call error:', err?.message);
    }
  }

  // Fallback shop name resolution from filename/title if visual OCR didn't resolve a valid shop name
  if (!resolvedShopName || resolvedShopName === 'NOT_FOUND') {
    if (pdfTitle && pdfTitle.trim().length >= 3) {
      const cleanedTitle = cleanGenericFilename(pdfTitle);
      if (cleanedTitle) {
        resolvedShopName = cleanedTitle;
        console.log(`[WORKER PARSER] Resolved from Illustrator Title: "${resolvedShopName}"`);
      }
    }

    if (!resolvedShopName || resolvedShopName === 'NOT_FOUND') {
      for (const fn of fileNames) {
        const cleaned = cleanGenericFilename(fn);
        if (cleaned) {
          resolvedShopName = cleaned;
          console.log(`[WORKER PARSER] Resolved from Filename: "${resolvedShopName}"`);
          break;
        }
      }
    }
  }

  // Safety sanitization & cross-category reconciliation
  if (regexSpecs.jobCategory === 'STICKER' && resolvedCategory !== 'COUPON') {
    resolvedCategory = 'STICKER';
  } else if (regexSpecs.jobCategory === 'COUPON') {
    resolvedCategory = 'COUPON';
  }

  if (resolvedCategory === 'FLYER' && resolvedWorkDetails) {
    resolvedWorkDetails = resolvedWorkDetails.replace(/\s*\b(FLYER|FLAYER|OFFER\s*PAPER)\b/gi, '').trim();
    if (regexSpecs.workDetails && /\bA\d\s*TO\s*A\d\b/i.test(regexSpecs.workDetails)) {
      resolvedWorkDetails = regexSpecs.workDetails;
    }
  } else if (resolvedCategory === 'STICKER') {
    const dimMatch = (resolvedWorkDetails || '').match(/(\d{1,4}\s*[/xX]\s*\d{1,4})/i) ||
                     (regexSpecs.extractedDimension ? [null, regexSpecs.extractedDimension] : null);
    const dim = dimMatch ? dimMatch[1].replace(/\s+/g, '').toUpperCase() : '';
    const dimPrefix = dim ? `${dim} ` : '';
    if (!resolvedWorkDetails || !resolvedWorkDetails.toUpperCase().includes('STICKER')) {
      resolvedWorkDetails = `${dimPrefix}STICKER`;
    }
  } else if (resolvedCategory === 'COUPON') {
    const dimMatch = (resolvedWorkDetails || '').match(/(\d{1,4}\s*[/xX]\s*\d{1,4})/i) ||
                     (regexSpecs.extractedDimension ? [null, regexSpecs.extractedDimension] : null);
    const dim = dimMatch ? dimMatch[1].replace(/\s+/g, '').toUpperCase() : '';
    const dimPrefix = dim ? `${dim} ` : '';
    if (regexSpecs.isNumbering || /numbering/i.test(specText)) {
      resolvedWorkDetails = `${dimPrefix}COUPON WITH NUMBERING`;
    } else {
      resolvedWorkDetails = (resolvedWorkDetails || '').replace(/\s*\bSTICKER\b/gi, '').trim();
      if (!resolvedWorkDetails.toUpperCase().includes('COUPON')) {
        resolvedWorkDetails = `${dimPrefix}COUPON`;
      }
    }
  } else if (resolvedCategory === 'PUSH_PULL') {
    resolvedWorkDetails = 'PUSH & PULL STICKER';
  } else if (resolvedCategory === 'VISITING_CARD') {
    if (!resolvedWorkDetails || !resolvedWorkDetails.toUpperCase().includes('VISITING CARD')) {
      resolvedWorkDetails = resolvedPageCount > 1 ? 'VISITING CARD BOTH SIDE' : 'VISITING CARD';
    }
  }

  return {
    jobCategory: resolvedCategory,
    shopName: resolvedShopName || 'NOT_FOUND',
    workDetails: resolvedWorkDetails || regexSpecs.workDetails || 'A4',
    pageCount: resolvedPageCount,
    quantity: resolvedQuantity || regexSpecs.quantity || 1000,
    confidence: resolvedShopName && resolvedShopName !== 'NOT_FOUND' ? 'HIGH' : 'LOW'
  };
}
