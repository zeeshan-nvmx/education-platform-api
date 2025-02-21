const tus = require('tus-js-client')

class CloudflareService {
  constructor() {
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`
  }

  async uploadVideo(file) {
    if (!file || !file.buffer) {
      throw new Error('Invalid file input')
    }

    try {
      let mediaId = ''

      return new Promise((resolve, reject) => {
        var options = {
          endpoint: this.baseUrl,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
          chunkSize: 50 * 1024 * 1024, // Required a minimum chunk size of 5 MB. Here we use 50 MB.
          retryDelays: [0, 3000, 5000, 10000, 20000],
          metadata: {
            name: file.originalname,
            filetype: file.mimetype,
          },
          uploadSize: file.size,
          onError: function (error) {
            console.error('Upload failed:', error)
            reject(error)
          },
          onProgress: function (bytesUploaded, bytesTotal) {
            var percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2)
            console.log(bytesUploaded, bytesTotal, percentage + '%')
          },
          onSuccess: async function () {
            try {
              console.log('Upload finished')
              await new Promise((resolve) => setTimeout(resolve, 2000))
              const videoDetails = await this.waitForProcessing(mediaId)
              resolve({
                videoId: mediaId,
                videoDetails,
              })
            } catch (error) {
              reject(error)
            }
          }.bind(this),
          onAfterResponse: function (req, res) {
            return new Promise((resolve) => {
              var mediaIdHeader = res.getHeader('stream-media-id')
              if (mediaIdHeader) {
                mediaId = mediaIdHeader
              }
              resolve()
            })
          },
        }

        // Use the buffer directly with tus
        var upload = new tus.Upload(file.buffer, options)
        upload.start()
      })
    } catch (error) {
      console.error('Error in upload process:', error)
      throw error
    }
  }

  async waitForProcessing(videoId) {
    let attempts = 0
    const maxAttempts = 30
    const retryDelay = 10000

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`${this.baseUrl}/${videoId}`, {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        })

        if (!response.ok) {
          const error = await response.json()
          throw new Error(`Failed to get video status: ${JSON.stringify(error)}`)
        }

        const data = await response.json()
        const videoDetails = data.result

        console.log(`Processing status (${attempts + 1}/${maxAttempts}):`, {
          phase: videoDetails.status?.state,
          pctComplete: videoDetails.status?.pctComplete,
        })

        if (videoDetails.status?.state === 'ready' || videoDetails.readyToStream === true) {
          return {
            status: videoDetails.status,
            duration: videoDetails.duration,
            thumbnail: videoDetails.thumbnail,
            playbackUrl: videoDetails.playback?.hls,
            dashUrl: videoDetails.playback?.dash,
            rawUrl: videoDetails.input?.src,
            meta: {
              size: videoDetails.size,
              created: videoDetails.created,
              modified: videoDetails.modified,
            },
          }
        }

        if (videoDetails.status?.state === 'failed') {
          throw new Error(`Video processing failed: ${videoDetails.status?.errorReasonText || 'Unknown error'}`)
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay))
        attempts++
      } catch (error) {
        console.error(`Processing check attempt ${attempts + 1} failed:`, error)
        if (attempts === maxAttempts - 1) throw error
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
        attempts++
      }
    }

    throw new Error('Video processing timed out')
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
      try {
        await this.getVideoDetails(videoId)
      } catch (error) {
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
