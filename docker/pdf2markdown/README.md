# Locus PDF import worker

Internal persistent Mistral OCR service used by Locus Chat. It accepts authenticated
PDF jobs, processes a bounded number in parallel, and stores each user's source PDF,
Markdown, and extracted images under a tenant-isolated path.
