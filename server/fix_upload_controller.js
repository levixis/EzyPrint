const fs = require('fs');
const file = 'src/controllers/upload.controller.ts';
let code = fs.readFileSync(file, 'utf8');

const regex1 = /const results = await Promise\.all\(files\.map\(\(file\) => storageService\.uploadFile\(file\.buffer, file\.originalname, file\.mimetype, folder\)\)\);/;

const replace1 = `
    const existingOrderFiles = targetOrder ? await prisma.orderFile.findMany({ where: { uploadId: { in: uploadIds }, fileStoragePath: { not: null } } }) : [];
    if (existingOrderFiles.length > 0) {
      return res.status(200).json({ success: true, message: 'Files already uploaded', data: { files: existingOrderFiles.map(f => ({ storageKey: f.fileStoragePath, originalName: f.fileName, mimeType: f.fileType, sizeBytes: f.fileSizeBytes })) } });
    }

    const existingTicketAttachments = targetTicket ? await prisma.ticketAttachment.findMany({ where: { uploadId: { in: uploadIds } } }) : [];
    if (existingTicketAttachments.length > 0) {
      return res.status(200).json({ success: true, message: 'Files already uploaded', data: { files: existingTicketAttachments.map(f => ({ storageKey: f.storageKey, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes })) } });
    }

    const uploadPromises = files.map((file) => storageService.uploadFile(file.buffer, file.originalname, file.mimetype, folder));
    const settledResults = await Promise.allSettled(uploadPromises);
    
    const results: any[] = [];
    const failed: any[] = [];
    for (const r of settledResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else failed.push(r.reason);
    }
    
    if (failed.length > 0) {
      await Promise.allSettled(results.map(r => storageService.deleteFile(r.storageKey)));
      throw ApiError.internal('One or more files failed to upload to storage');
    }`;

code = code.replace(regex1, replace1);
fs.writeFileSync(file, code);
