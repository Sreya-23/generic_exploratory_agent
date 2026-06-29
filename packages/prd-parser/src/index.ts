import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface ParsedPrd {
  features: string[];
  constraints: string[];
  rawText: string;
}

const FEATURE_PATTERNS = [
  /(?:user story|as a .+?, i want|feature|requirement|shall|must)\s*[:\-]?\s*(.+)/gi,
  /^\s*[-*]\s+(.{20,})/gm,
  /^\s*\d+\.\s+(.{20,})/gm,
];

function extractFeatures(text: string): string[] {
  const features = new Set<string>();

  for (const pattern of FEATURE_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const line = match[1]?.trim();
      if (line && line.length > 15 && line.length < 500) {
        features.add(line);
      }
    }
  }

  return Array.from(features).slice(0, 30);
}

function extractConstraints(text: string): string[] {
  const constraints: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      (lower.includes('must') || lower.includes('shall') || lower.includes('validate')) &&
      line.trim().length > 20
    ) {
      constraints.push(line.trim());
    }
  }
  return constraints.slice(0, 20);
}

export async function parsePrd(filePath: string): Promise<ParsedPrd> {
  const ext = extname(filePath).toLowerCase();
  let rawText: string;

  if (ext === '.md' || ext === '.txt' || ext === '.json') {
    rawText = await readFile(filePath, 'utf-8');
  } else if (ext === '.pdf') {
    rawText = await readFile(filePath, 'utf-8').catch(() => {
      throw new Error(
        'PDF parsing requires text extraction — upload .md or .txt for now, or install pdf parser',
      );
    });
  } else {
    rawText = await readFile(filePath, 'utf-8');
  }

  return {
    features: extractFeatures(rawText),
    constraints: extractConstraints(rawText),
    rawText: rawText.slice(0, 50000),
  };
}
