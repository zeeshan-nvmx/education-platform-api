// const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')

// const s3 = new S3Client({
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//   },
//   region: 'auto', // R2 uses 'auto' region
//   endpoint: process.env.AWS_ENDPOINT,
//   signatureVersion: 'v4', // Required for R2
// })

// const uploadToS3 = async (file, key) => {
//   const params = {
//     Bucket: process.env.AWS_BUCKET_NAME,
//     Key: key,
//     Body: file.buffer,
//     ContentType: file.mimetype,
//   }

//   try {
//     await s3.send(new PutObjectCommand(params))

//     // Use your R2 dev URL for public access
//     const publicUrl = `${process.env.AWS_PUBLIC_URL}/${key}`
//     return publicUrl
//   } catch (err) {
//     console.error('Error uploading file to S3:', err)
//     throw err
//   }
// }

// const deleteFromS3 = async (key) => {
//   const params = {
//     Bucket: process.env.AWS_BUCKET_NAME,
//     Key: key,
//   }

//   try {
//     await s3.send(new DeleteObjectCommand(params))
//   } catch (err) {
//     console.error('Error deleting file from S3:', err)
//     throw err
//   }
// }

// module.exports = {
//   uploadToS3,
//   deleteFromS3,
// }


const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const path = require('path')
const crypto = require('crypto')

// Initialize S3 Client
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: 'auto',
  endpoint: process.env.AWS_ENDPOINT,
  signatureVersion: 'v4',
})

// Config object for file types and limits
const fileConfig = {
  image: {
    allowedTypes: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    maxSize: 5 * 1024 * 1024, // 5MB
    prefix: 'images',
  },
  document: {
    allowedTypes: ['.pdf', '.doc', '.docx', '.txt', '.rtf'],
    maxSize: 10 * 1024 * 1024, // 10MB
    prefix: 'documents',
  },
  quiz_attachment: {
    allowedTypes: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.md', '.js', '.py', '.java'],
    maxSize: 5 * 1024 * 1024, // 5MB
    prefix: 'quiz-attachments',
  },
  lesson_asset: {
    allowedTypes: ['.pdf', '.doc', '.docx', '.txt', '.zip', '.rar', '.ppt', '.pptx', '.xls', '.xlsx'],
    maxSize: 50 * 1024 * 1024, // 50MB
    prefix: 'lesson-assets',
  },
}

/**
 * Original uploadToS3 function with enhanced capabilities
 * Maintains original signature for backward compatibility
 * @param {Object} file - The file object from multer
 * @param {String} key - Optional key override (for backward compatibility)
 * @param {Object} options - Additional options
 */
const uploadToS3 = async (file, key = null, options = {}) => {
  try {
    // Determine file type and validate
    const ext = path.extname(file.originalname).toLowerCase()
    const type = options.type || 'document'
    const config = fileConfig[type] || fileConfig.document

    // Validate file type and size
    if (!config.allowedTypes.includes(ext)) {
      throw new Error(`Invalid file type. Allowed types: ${config.allowedTypes.join(', ')}`)
    }

    if (file.size > config.maxSize) {
      throw new Error(`File too large. Maximum size: ${config.maxSize / (1024 * 1024)}MB`)
    }

    // Use provided key or generate one
    const fileKey = key || generateKey(file, config.prefix, options)

    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalName: file.originalname,
        uploadType: type,
        ...(options.metadata || {}),
      },
    }

    if (options.contentDisposition) {
      params.ContentDisposition = options.contentDisposition
    }

    await s3.send(new PutObjectCommand(params))

    // Return format matches original function for backward compatibility
    const publicUrl = `${process.env.AWS_PUBLIC_URL}/${fileKey}`
    return publicUrl
  } catch (err) {
    console.error('Error uploading file to S3:', err)
    throw err
  }
}

/**
 * Original deleteFromS3 function with enhanced error handling
 * Maintains original signature for backward compatibility
 */
const deleteFromS3 = async (key) => {
  try {
    if (!key) return

    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    }

    await s3.send(new DeleteObjectCommand(params))
  } catch (err) {
    console.error('Error deleting file from S3:', err)
    // Don't throw error for backward compatibility
    // Just log it as the original function did
  }
}

/**
 * New function for bulk uploads
 * @param {Array} files - Array of file objects
 * @param {Object} options - Upload options
 */
const uploadMultipleToS3 = async (files, options = {}) => {
  const results = []
  const uploadedFiles = []

  try {
    for (const file of files) {
      const result = await uploadToS3(file, null, options)
      uploadedFiles.push({ url: result, key: getKeyFromUrl(result) })
      results.push(result)
    }
    return results
  } catch (error) {
    // Clean up any uploaded files if there's an error
    await cleanupFiles(uploadedFiles.map((f) => f.key))
    throw error
  }
}

/**
 * New function for bulk deletes
 * @param {Array} keys - Array of keys to delete
 */
const deleteMultipleFromS3 = async (keys) => {
  const deletePromises = keys.filter(Boolean).map((key) => deleteFromS3(key))
  await Promise.allSettled(deletePromises)
}

/**
 * Generate a presigned URL for file download
 * @param {String} key - The S3 key of the file
 * @param {Number} expiresIn - URL expiration time in seconds
 */
const generatePresignedUrl = async (key, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    })

    return await getSignedUrl(s3, command, { expiresIn })
  } catch (error) {
    console.error('Error generating presigned URL:', error)
    throw error
  }
}

// Helper Functions
const generateKey = (file, prefix, options = {}) => {
  const timestamp = Date.now()
  const hash = crypto.randomBytes(4).toString('hex')
  const sanitizedName = path
    .basename(file.originalname, path.extname(file.originalname))
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()

  // Allow custom subfolders in the prefix
  const customPrefix = options.customPrefix ? `${prefix}/${options.customPrefix}` : prefix

  return `${customPrefix}/${sanitizedName}-${timestamp}-${hash}${path.extname(file.originalname)}`
}

const getKeyFromUrl = (url) => {
  const baseUrl = process.env.AWS_PUBLIC_URL
  return url.replace(`${baseUrl}/`, '')
}

const cleanupFiles = async (keys) => {
  try {
    await deleteMultipleFromS3(keys)
  } catch (error) {
    console.error('Error cleaning up files:', error)
  }
}

// Export both original and new functions
module.exports = {
  // Original exports for backward compatibility
  uploadToS3,
  deleteFromS3,

  // New enhanced functions
  uploadMultipleToS3,
  deleteMultipleFromS3,
  generatePresignedUrl,

  // Config export for validation in controllers
  fileConfig,
}