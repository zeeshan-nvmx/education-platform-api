// // utils/cloudflare.js
// const fetch = require('node-fetch')
// const FormData = require('form-data')

// class CloudflareService {
//   constructor() {
//     this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID
//     this.apiToken = process.env.CLOUDFLARE_API_TOKEN
//     this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`
//   }

//   async getUploadUrl() {
//     try {
//       const response = await fetch(`${this.baseUrl}/direct_upload`, {
//         method: 'POST',
//         headers: {
//           Authorization: `Bearer ${this.apiToken}`,
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({
//           maxDurationSeconds: 7200, // 2 hours max
//           allowedOrigins: [' '],
//         }),
//       })

//       if (!response.ok) {
//         const error = await response.json()
//         throw new Error(`Failed to get upload URL: ${JSON.stringify(error)}`)
//       }

//       const data = await response.json()
//       return {
//         uploadUrl: data.result.uploadURL,
//         videoId: data.result.uid,
//       }
//     } catch (error) {
//       console.error('Error getting upload URL:', error)
//       throw error
//     }
//   }

//   async uploadVideo(file) {
//     try {
//       // First get the upload URL
//       const { uploadUrl, videoId } = await this.getUploadUrl()

//       // Create FormData and append the file
//       const formData = new FormData()
//       formData.append('file', file.buffer, {
//         filename: file.originalname,
//         contentType: file.mimetype,
//       })

//       // Upload to Cloudflare
//       const uploadResponse = await fetch(uploadUrl, {
//         method: 'POST',
//         body: formData,
//         headers: {
//           ...formData.getHeaders(),
//         },
//       })

//       if (!uploadResponse.ok) {
//         const error = await uploadResponse.json()
//         throw new Error(`Failed to upload video: ${JSON.stringify(error)}`)
//       }

//       // Wait for video processing (with timeout)
//       let attempts = 0
//       const maxAttempts = 10
//       let videoDetails = null

//       while (attempts < maxAttempts) {
//         videoDetails = await this.getVideoDetails(videoId)
//         if (videoDetails.status.phase === 'ready') {
//           break
//         }
//         await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds between checks
//         attempts++
//       }

//       return { videoId, videoDetails }
//     } catch (error) {
//       console.error('Error uploading video:', error)
//       throw error
//     }
//   }

//   async deleteVideo(videoId) {
//     try {
//       // Check if video exists first
//       try {
//         await this.getVideoDetails(videoId)
//       } catch (error) {
//         // If video doesn't exist, return success
//         if (error.message.includes('not found')) {
//           return true
//         }
//         throw error
//       }

//       const response = await fetch(`${this.baseUrl}/${videoId}`, {
//         method: 'DELETE',
//         headers: {
//           Authorization: `Bearer ${this.apiToken}`,
//         },
//       })

//       if (!response.ok) {
//         const error = await response.json()
//         throw new Error(`Failed to delete video: ${JSON.stringify(error)}`)
//       }

//       return true
//     } catch (error) {
//       console.error('Error deleting video:', error)
//       throw error
//     }
//   }

//   async getVideoDetails(videoId) {
//     try {
//       const response = await fetch(`${this.baseUrl}/${videoId}`, {
//         headers: {
//           Authorization: `Bearer ${this.apiToken}`,
//         },
//       })

//       if (!response.ok) {
//         const error = await response.json()
//         if (response.status === 404) {
//           throw new Error('Video not found')
//         }
//         throw new Error(`Failed to get video details: ${JSON.stringify(error)}`)
//       }

//       const data = await response.json()
//       const result = data.result

//       return {
//         status: result.status,
//         duration: result.duration || 0,
//         thumbnail: result.thumbnail,
//         playbackUrl: result.playback?.hls,
//         dashUrl: result.playback?.dash,
//         rawUrl: result.input?.src,
//         meta: {
//           size: result.size,
//           created: result.created,
//           modified: result.modified,
//           status: result.status.phase,
//         },
//       }
//     } catch (error) {
//       console.error('Error getting video details:', error)
//       throw error
//     }
//   }
// }

// module.exports = new CloudflareService()


// utils/cloudflare.js
const fetch = require('node-fetch')
const FormData = require('form-data')

class CloudflareService {
  constructor() {
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`
  }

  async getUploadUrl() {
    try {
      const response = await fetch(`${this.baseUrl}/direct_upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          maxDurationSeconds: 7200, // 2 hours max
          allowedOrigins: [' '],
          // Enable MP4 downloads and set quality
          watermark: null,
          download: true, // Enable downloads
          downloadSettings: {
            autoGenerateMp4s: true, // Automatically generate MP4s
            defaultQuality: '1080p', // Set default quality for downloads
            qualities: ['1080p', '720p', '480p', '360p'], // Available quality options
          },
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`Failed to get upload URL: ${JSON.stringify(error)}`)
      }

      const data = await response.json()
      return {
        uploadUrl: data.result.uploadURL,
        videoId: data.result.uid,
      }
    } catch (error) {
      console.error('Error getting upload URL:', error)
      throw error
    }
  }

  async uploadVideo(file) {
    try {
      // First get the upload URL
      const { uploadUrl, videoId } = await this.getUploadUrl()

      // Create FormData and append the file
      const formData = new FormData()
      formData.append('file', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      })

      // Upload to Cloudflare
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
        headers: {
          ...formData.getHeaders(),
        },
      })

      if (!uploadResponse.ok) {
        const error = await uploadResponse.json()
        throw new Error(`Failed to upload video: ${JSON.stringify(error)}`)
      }

      // Wait for video processing (with timeout)
      let attempts = 0
      const maxAttempts = 10
      let videoDetails = null

      while (attempts < maxAttempts) {
        videoDetails = await this.getVideoDetails(videoId)
        if (videoDetails.status.phase === 'ready') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds between checks
        attempts++
      }

      return { videoId, videoDetails }
    } catch (error) {
      console.error('Error uploading video:', error)
      throw error
    }
  }

  async getVideoDetails(videoId) {
    try {
      const response = await fetch(`${this.baseUrl}/${videoId}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      })

      if (!response.ok) {
        const error = await response.json()
        if (response.status === 404) {
          throw new Error('Video not found')
        }
        throw new Error(`Failed to get video details: ${JSON.stringify(error)}`)
      }

      const data = await response.json()
      const result = data.result

      return {
        status: result.status,
        duration: result.duration || 0,
        thumbnail: result.thumbnail,
        playbackUrl: result.playback?.hls,
        dashUrl: result.playback?.dash,
        rawUrl: result.input?.src,
        // Add MP4 download URLs to the response
        downloads: result.download?.mp4 || {},
        meta: {
          size: result.size,
          created: result.created,
          modified: result.modified,
          status: result.status.phase,
        },
      }
    } catch (error) {
      console.error('Error getting video details:', error)
      throw error
    }
  }

  async deleteVideo(videoId) {
    try {
      // Check if video exists first
      try {
        await this.getVideoDetails(videoId)
      } catch (error) {
        // If video doesn't exist, return success
        if (error.message.includes('not found')) {
          return true
        }
        throw error
      }

      const response = await fetch(`${this.baseUrl}/${videoId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`Failed to delete video: ${JSON.stringify(error)}`)
      }

      return true
    } catch (error) {
      console.error('Error deleting video:', error)
      throw error
    }
  }
}

module.exports = new CloudflareService()