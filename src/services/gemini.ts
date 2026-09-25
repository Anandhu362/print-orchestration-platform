import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/environment';

// Initialize the official Google Generative AI client
export const ai = new GoogleGenerativeAI(env.GEMINI_API_KEY);