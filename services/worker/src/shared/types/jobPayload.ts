export interface DocumentMediaPayload {
  messageId: string;
  fileName: string;
  fileLength?: number;
  pageCount?: number;
  mimetype?: string;
  directPath?: string;
  url?: string;
  mediaKey?: string; // base64 string
  fileEncSha256?: string; // base64 string
  fileSha256?: string; // base64 string
  thumbnailBase64?: string;
  caption?: string;
  pdfTitle?: string;
}

export interface JobDispatchPayload {
  jobId: string;
  groupId: string;
  senderId: string;
  specText: string;
  isDirectChat: boolean;
  documents: DocumentMediaPayload[];
  createdAt: number;
}

export interface JobProcessResult {
  success: boolean;
  jobId: string;
  jobCategory?: string;
  shopName?: string;
  workDetails?: string;
  pageCount?: number;
  quantity?: number;
  sheetTitle?: string;
  rowIndex?: number;
  siNo?: number;
  skippedForManualReview?: boolean;
  error?: string;
}
