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
