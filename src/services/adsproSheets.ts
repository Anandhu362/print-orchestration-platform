import { google } from 'googleapis';
import { env } from '../config/environment';
import { escapeSpreadsheetFormula } from '../utils/sanitizer';
import { retryWithBackoff } from '../utils/retry';

// Initialize Google Auth client
const auth = new google.auth.JWT({
  email: env.GCP_SERVICE_ACCOUNT_KEY.client_email,
  key: env.GCP_SERVICE_ACCOUNT_KEY.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

export interface AdsproJobRecord {
  shopName: string;
  workDetails: string;
  pageCount: number;
  quantity: number;
  timestamp?: Date;
}

export interface DubaiWeekDetails {
  sheetTitle: string;
  weekNum: number;
  monthName: string;
  year: number;
  dateRangeString: string;
}

/**
 * Calculates the calendar week of the month starting strictly on Monday
 * in Gulf Standard Time (Asia/Dubai, UTC+4).
 * 
 * Every Monday 00:00 GST, this transitions to the next sequential week tab
 * (e.g. "SEPTEMBER 3RD WEEK" -> "SEPTEMBER 4TH WEEK").
 * Month boundaries dynamically reset to "1ST WEEK" of the new month.
 */
export function getDubaiWeekDetails(baseDate: Date = new Date()): DubaiWeekDetails {
  const dxbString = baseDate.toLocaleString('en-US', { timeZone: 'Asia/Dubai' });
  const dxbDate = new Date(dxbString);

  const months = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
  ];

  const year = dxbDate.getFullYear();
  const monthIndex = dxbDate.getMonth();
  const monthName = months[monthIndex];
  const dayOfMonth = dxbDate.getDate();

  // 1. Find the weekday of the 1st day of this month
  // JS getDay(): 0 = Sun, 1 = Mon, 2 = Tue, ..., 6 = Sat
  const firstDayOfMonth = new Date(year, monthIndex, 1);
  const firstDayOfWeek = firstDayOfMonth.getDay();

  // 2. Monday-based offset (0 if 1st is Mon, 1 if Tue, ..., 6 if Sun)
  const mondayOffset = (firstDayOfWeek + 6) % 7;

  // 3. Calculate week number (rolls over cleanly every Monday 00:00 GST)
  const weekNum = Math.floor((dayOfMonth + mondayOffset - 1) / 7) + 1;

  const ordinals = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];
  const ordinal = ordinals[weekNum - 1] || `${weekNum}TH`;

  // 4. Calculate this week's Monday and Sunday date range for logs/headers
  const currentDayOfWeekMonBased = (dxbDate.getDay() + 6) % 7;
  const mondayDate = new Date(dxbDate);
  mondayDate.setDate(dxbDate.getDate() - currentDayOfWeekMonBased);
  const sundayDate = new Date(mondayDate);
  sundayDate.setDate(mondayDate.getDate() + 6);

  const dateRangeString = `${mondayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${sundayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  return {
    sheetTitle: `${monthName} ${ordinal} WEEK`,
    weekNum,
    monthName,
    year,
    dateRangeString
  };
}

/**
 * Calculates week of the month in Gulf Standard Time (Asia/Dubai).
 * E.g., "SEPTEMBER 3RD WEEK"
 */
export function getDubaiWeekTitle(baseDate: Date = new Date()): string {
  return getDubaiWeekDetails(baseDate).sheetTitle;
}

/**
 * Ensures the target weekly tab exists in Google Sheets with the exact
 * corporate header, styling, borders, and VAT calculation formulas.
 */
export async function ensureWeeklySheetExists(
  spreadsheetId: string,
  sheetTitle: string,
  dateRangeString?: string,
  year: number = new Date().getFullYear()
): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = meta.data.sheets?.find(s => s.properties?.title === sheetTitle);

  if (existingSheet?.properties?.sheetId !== undefined && existingSheet?.properties?.sheetId !== null) {
    return existingSheet.properties.sheetId;
  }

  const rangeSuffix = dateRangeString ? ` (${dateRangeString})` : '';
  console.log(`[ADSPRO SHEETS] Creating new weekly tab: "${sheetTitle}"${rangeSuffix}`);

  // 1. Add the new sheet tab
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetTitle,
              gridProperties: {
                rowCount: 100,
                columnCount: 12
              }
            }
          }
        }
      ]
    }
  });

  const newSheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error(`Failed to create new sheet tab "${sheetTitle}"`);
  }

  // 2. Populate standard header rows: Row 2 Title, Row 3 Column Headers
  const bannerTitle = `ADSPRO WORK DETAILS - ${year}${rangeSuffix}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetTitle}'!A2:J3`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        // Row 2: Title
        [bannerTitle, '', '', '', '', '', '', '', '', ''],
        // Row 3: Headers
        [
          'SI No.',
          'Shop Name',
          'Work Details',
          'NO.PAGE',
          'Quantity',
          'Cost (With out Tax)',
          'Cost (With Tax)',
          'Selling With out tax',
          'Selling with tax',
          'Margin'
        ]
      ]
    }
  });

  // 3. Format header styling (Dark Navy banner, Lavender column headers, merged cells)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Merge A2:J2 for the title banner
        {
          mergeCells: {
            range: {
              sheetId: newSheetId,
              startRowIndex: 1, // Row 2 (0-indexed)
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 10
            },
            mergeType: 'MERGE_ALL'
          }
        },
        // Style Row 2 Title: Dark Navy #1F3864, White bold text, 14pt, centered
        {
          repeatCell: {
            range: {
              sheetId: newSheetId,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 10
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.12, green: 0.22, blue: 0.39 },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  fontSize: 14,
                  bold: true
                }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)'
          }
        },
        // Style Row 3 Headers: Lavender #D9E1F2, Bold text, centered
        {
          repeatCell: {
            range: {
              sheetId: newSheetId,
              startRowIndex: 2, // Row 3 (0-indexed)
              endRowIndex: 3,
              startColumnIndex: 0,
              endColumnIndex: 10
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.85, green: 0.88, blue: 0.95 },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
                textFormat: {
                  fontSize: 10,
                  bold: true
                }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)'
          }
        },
        // Set column widths
        {
          updateDimensionProperties: {
            range: {
              sheetId: newSheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 1
            },
            properties: { pixelSize: 60 }, // SI No.
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: newSheetId,
              dimension: 'COLUMNS',
              startIndex: 1,
              endIndex: 2
            },
            properties: { pixelSize: 220 }, // Shop Name
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: newSheetId,
              dimension: 'COLUMNS',
              startIndex: 2,
              endIndex: 3
            },
            properties: { pixelSize: 130 }, // Work Details
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: newSheetId,
              dimension: 'COLUMNS',
              startIndex: 3,
              endIndex: 4
            },
            properties: { pixelSize: 90 }, // NO.PAGE
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: newSheetId,
              dimension: 'COLUMNS',
              startIndex: 4,
              endIndex: 5
            },
            properties: { pixelSize: 100 }, // Quantity
            fields: 'pixelSize'
          }
        }
      ]
    }
  });

  console.log(`[ADSPRO SHEETS] Weekly tab "${sheetTitle}" created and styled successfully.`);
  return newSheetId;
}

/**
 * Appends a print order record to the active weekly sheet tab.
 * Computes the next SI No., sets standard VAT formulas, and applies formatting.
 */
export async function appendAdsproJobToSheet(job: AdsproJobRecord): Promise<{ sheetTitle: string; siNo: number; rowIndex: number }> {
  const spreadsheetId = env.ADSPRO_SHEET_ID;
  const weekDetails = getDubaiWeekDetails(job.timestamp || new Date());
  const sheetTitle = weekDetails.sheetTitle;

  // 1. Ensure the week tab exists (creates and styles new tab if first job of the week!)
  const sheetId = await ensureWeeklySheetExists(
    spreadsheetId,
    sheetTitle,
    weekDetails.dateRangeString,
    weekDetails.year
  );

  // 2. Find the current last filled row in this tab
  const rangeCheck = `'${sheetTitle}'!A4:A100`;
  const existingRows = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeCheck
  });

  const filledCount = existingRows.data.values ? existingRows.data.values.length : 0;
  const siNo = filledCount + 1;
  const targetRowIndex = 4 + filledCount; // 1-indexed Excel row number

  // 3. Prepare row values:
  // Col A: SI No.
  // Col B: Shop Name
  // Col C: Work Details
  // Col D: NO.PAGE
  // Col E: Quantity
  // Col F: Cost (With out Tax) [blank for manual entry]
  // Col G: Cost (With Tax) [Formula: =F{row}*1.05]
  // Col H: Selling With out tax [blank for manual entry]
  // Col I: Selling with tax [Formula: =H{row}*1.05]
  // Col J: Margin [Formula: =H{row}-F{row}]
  const rowValues = [
    siNo,
    escapeSpreadsheetFormula(job.shopName.toUpperCase()),
    escapeSpreadsheetFormula(job.workDetails.toUpperCase()),
    job.pageCount,
    job.quantity,
    '', // Cost without tax
    `=IF(ISBLANK(F${targetRowIndex}), "", F${targetRowIndex}*1.05)`,
    '', // Selling without tax
    `=IF(ISBLANK(H${targetRowIndex}), "", H${targetRowIndex}*1.05)`,
    `=IF(AND(ISBLANK(F${targetRowIndex}), ISBLANK(H${targetRowIndex})), "", H${targetRowIndex}-F${targetRowIndex})`
  ];

  // 4. Append row values (with exponential retry protection)
  await retryWithBackoff(
    () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetTitle}'!A${targetRowIndex}:J${targetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowValues]
      }
    }),
    {
      retries: 3,
      initialDelayMs: 1500,
      operationName: `Google Sheets values.update [${sheetTitle}!A${targetRowIndex}]`
    }
  );

  // 5. Apply clean borders and cell formatting to the new row
  await retryWithBackoff(
    () => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: targetRowIndex - 1,
                endRowIndex: targetRowIndex,
                startColumnIndex: 0,
                endColumnIndex: 10
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                  textFormat: {
                    fontSize: 10
                  }
                }
              },
              fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)'
            }
          },
          // Left align the Shop Name for clean readability
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: targetRowIndex - 1,
                endRowIndex: targetRowIndex,
                startColumnIndex: 1,
                endColumnIndex: 2
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'LEFT',
                  textFormat: {
                    bold: true,
                    fontSize: 10
                  }
                }
              },
              fields: 'userEnteredFormat(horizontalAlignment,textFormat)'
            }
          }
        ]
      }
    }),
    {
      retries: 3,
      initialDelayMs: 1500,
      operationName: `Google Sheets batchUpdate formatting [${sheetTitle}]`
    }
  );

  console.log(`[ADSPRO SHEETS] Logged Job #${siNo} for "${job.shopName}" to "${sheetTitle}" at Row ${targetRowIndex}.`);
  return { sheetTitle, siNo, rowIndex: targetRowIndex };
}
