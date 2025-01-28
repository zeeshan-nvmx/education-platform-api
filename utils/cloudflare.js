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
          maxDurationSeconds: 7200,
          allowedOrigins: [
            'localhost:3000', // Local development without protocol
            'localhost:5173', // Vite default port
            'localhost',
            ' ',
          ],
          requireSignedURLs: false,
          enabledDownload: false,
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

  // async uploadVideo(file) {
  //   try {
  //     // First get the upload URL
  //     const { uploadUrl, videoId } = await this.getUploadUrl()

  //     // Create FormData and append the file
  //     const formData = new FormData()
  //     formData.append('file', file.buffer, {
  //       filename: file.originalname,
  //       contentType: file.mimetype,
  //     })

  //     // Upload to Cloudflare with timeout and retry logic
  //     const uploadResponse = await fetch(uploadUrl, {
  //       method: 'POST',
  //       body: formData,
  //       headers: {
  //         ...formData.getHeaders(),
  //       },
  //       // Add timeout of 5 minutes
  //       timeout: 300000,
  //     }).catch(async (error) => {
  //       console.error('Initial upload failed, retrying:', error)
  //       // Retry once after 5 seconds
  //       await new Promise((resolve) => setTimeout(resolve, 5000))
  //       return fetch(uploadUrl, {
  //         method: 'POST',
  //         body: formData,
  //         headers: {
  //           ...formData.getHeaders(),
  //         },
  //       })
  //     })

  //     if (!uploadResponse.ok) {
  //       const error = await uploadResponse.json()
  //       throw new Error(`Failed to upload video: ${JSON.stringify(error)}`)
  //     }

  //     // Wait for video processing with better timeout handling
  //     let attempts = 0
  //     const maxAttempts = 20 // 2 minutes total wait time
  //     let videoDetails = null

  //     while (attempts < maxAttempts) {
  //       try {
  //         videoDetails = await this.getVideoDetails(videoId)
  //         console.log(`Processing status (${attempts + 1}/${maxAttempts}):`, videoDetails.status.phase)

  //         if (videoDetails.status.phase === 'ready') {
  //           console.log('Video ready:', videoId)
  //           break
  //         }

  //         if (videoDetails.status.phase === 'failed') {
  //           throw new Error('Video processing failed')
  //         }
  //       } catch (error) {
  //         console.error(`Attempt ${attempts + 1} failed:`, error)
  //         if (attempts === maxAttempts - 1) throw error
  //       }

  //       await new Promise((resolve) => setTimeout(resolve, 6000)) // 6 second delay between checks
  //       attempts++
  //     }

  //     if (!videoDetails || videoDetails.status.phase !== 'ready') {
  //       throw new Error('Video processing timed out')
  //     }

  //     return {
  //       videoId,
  //       videoDetails,
  //       playbackUrl: videoDetails.playbackUrl,
  //       status: 'success',
  //     }
  //   } catch (error) {
  //     console.error('Error in upload process:', error)
  //     throw error
  //   }
  // }

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

      // Initial delay before checking status
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Wait for video processing with improved status checking
      let attempts = 0
      const maxAttempts = 20 // 2 minutes total wait time
      let videoDetails = null

      while (attempts < maxAttempts) {
        try {
          const response = await fetch(`${this.baseUrl}/${videoId}`, {
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
            },
          })

          if (!response.ok) {
            throw new Error('Failed to get video status')
          }

          const data = await response.json()
          videoDetails = data.result

          console.log(`Processing status (${attempts + 1}/${maxAttempts}):`, {
            phase: videoDetails.status?.state,
            pctComplete: videoDetails.status?.pctComplete,
          })

          // Check both status.state and readyToStream
          if (videoDetails.status?.state === 'ready' || videoDetails.readyToStream === true) {
            console.log('Video is ready:', videoId)
            return {
              videoId,
              videoDetails: {
                status: videoDetails.status,
                duration: videoDetails.duration,
                thumbnail: videoDetails.thumbnail,
                playbackUrl: videoDetails.playback?.hls,
                dashUrl: videoDetails.playback?.dash,
                meta: {
                  size: videoDetails.size,
                  created: videoDetails.created,
                  modified: videoDetails.modified,
                },
              },
            }
          }

          if (videoDetails.status?.state === 'failed') {
            throw new Error('Video processing failed')
          }
        } catch (error) {
          console.error(`Attempt ${attempts + 1} failed:`, error)
          if (attempts === maxAttempts - 1) throw error
        }

        await new Promise((resolve) => setTimeout(resolve, 6000)) // 6 second delay between checks
        attempts++
      }

      throw new Error('Video processing timed out or status check failed')
    } catch (error) {
      console.error('Error in upload process:', error)
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
        status: {
          state: result.status?.state,
          pctComplete: result.status?.pctComplete,
          errorReasonCode: result.status?.errorReasonCode,
          errorReasonText: result.status?.errorReasonText,
        },
        readyToStream: result.readyToStream,
        duration: result.duration || 0,
        thumbnail: result.thumbnail,
        playbackUrl: result.playback?.hls,
        dashUrl: result.playback?.dash,
        rawUrl: result.input?.src,
        meta: {
          size: result.size,
          created: result.created,
          modified: result.modified,
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