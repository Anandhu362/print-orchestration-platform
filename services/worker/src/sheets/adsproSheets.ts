import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
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

export function escapeSpreadsheetFormula(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export interface DubaiWeekDetails {
  sheetTitle: string;
  weekNum: number;
  monthName: string;
  year: number;
  dateRangeString: string;
}

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

  const firstDayOfMonth = new Date(year, monthIndex, 1);
  const firstDayOfWeek = firstDayOfMonth.getDay();
  const mondayOffset = (firstDayOfWeek + 6) % 7;
  const weekNum = Math.floor((dayOfMonth + mondayOffset - 1) / 7) + 1;

  const ordinals = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];
  const ordinal = ordinals[weekNum - 1] || `${weekNum}TH`;

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

  const bannerTitle = `ADSPRO WORK DETAILS - ${year}${rangeSuffix}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetTitle}'!A2:J3`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [bannerTitle, '', '', '', '', '', '', '', '', ''],
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

  console.log(`[ADSPRO SHEETS] Weekly tab "${sheetTitle}" created successfully.`);
  return newSheetId;
}

export async function appendAdsproJobToSheet(job: AdsproJobRecord): Promise<{ sheetTitle: string; siNo: number; rowIndex: number }> {
  const spreadsheetId = process.env.ADSPRO_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('[FATAL] Configuration Error: System environment variable "ADSPRO_SHEET_ID" is missing.');
  }
  const weekDetails = getDubaiWeekDetails(job.timestamp || new Date());
  const sheetTitle = weekDetails.sheetTitle;

  const sheetId = await ensureWeeklySheetExists(
    spreadsheetId,
    sheetTitle,
    weekDetails.dateRangeString,
    weekDetails.year
  );

  const rangeCheck = `'${sheetTitle}'!A4:A100`;
  const existingRows = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeCheck
  });

  const filledCount = existingRows.data.values ? existingRows.data.values.length : 0;
  const siNo = filledCount + 1;
  const targetRowIndex = 4 + filledCount;

  const rowValues = [
    siNo,
    escapeSpreadsheetFormula(job.shopName.toUpperCase()),
    escapeSpreadsheetFormula(job.workDetails.toUpperCase()),
    job.pageCount,
    job.quantity,
    '',
    `=IF(ISBLANK(F${targetRowIndex}), "", F${targetRowIndex}*1.05)`,
    '',
    `=IF(ISBLANK(H${targetRowIndex}), "", H${targetRowIndex}*1.05)`,
    `=IF(AND(ISBLANK(F${targetRowIndex}), ISBLANK(H${targetRowIndex})), "", H${targetRowIndex}-F${targetRowIndex})`
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetTitle}'!A${targetRowIndex}:J${targetRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [rowValues]
    }
  });

  // Apply corporate formatting matching existing rows:
  // - Columns A to J centered vertically & horizontally with font size 10, Arial
  // - Column B (Shop Name) Bold and Left-aligned
  try {
    await sheets.spreadsheets.batchUpdate({
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
                    fontSize: 10,
                    bold: false,
                    fontFamily: 'Arial'
                  }
                }
              },
              fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)'
            }
          },
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
                  verticalAlignment: 'MIDDLE',
                  textFormat: {
                    bold: true,
                    fontSize: 10,
                    fontFamily: 'Arial'
                  }
                }
              },
              fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)'
            }
          }
        ]
      }
    });
  } catch (fmtErr: any) {
    console.warn(`[ADSPRO SHEETS] Formatting batchUpdate warning for Row ${targetRowIndex}:`, fmtErr?.message);
  }

  console.log(`[ADSPRO SHEETS] Logged Job #${siNo} for "${job.shopName}" to "${sheetTitle}" at Row ${targetRowIndex}.`);
  return { sheetTitle, siNo, rowIndex: targetRowIndex };
}
