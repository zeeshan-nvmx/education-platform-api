const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'subAdmin', 'moderator'],
      default: 'user',
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    verificationToken: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    enrolledCourses: [
      {
        course: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Course',
          index: true,
        },
        enrolledAt: {
          type: Date,
          default: Date.now,
        },
        enrollmentType: {
          type: String,
          enum: ['full', 'module'],
          required: true,
        },
        enrolledModules: [
          {
            module: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Module',
            },
            enrolledAt: {
              type: Date,
              default: Date.now,
            },
            completedLessons: [
              {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Lesson',
              },
            ],
            completedQuizzes: [
              {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Quiz',
              },
            ],
            lastAccessed: {
              type: Date,
              default: Date.now,
            },
          },
        ],
      },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
)

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

userSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

userSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})

const instructorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    designation: {
      type: String,
      trim: true,
    },
    expertise: [
      {
        type: String,
        trim: true,
      },
    ],
    image: {
      type: String,
      trim: true,
    },
    imageKey: {
      type: String,
      trim: true,
    },
    socialLinks: {
      linkedin: String,
      twitter: String,
      website: String,
    },
    bio: {
      type: String,
      trim: true,
    },
    achievements: [String],
  },
  { _id: true }
)

const courseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
      index: true,
    },
    thumbnail: {
      type: String,
      trim: true,
    },
    thumbnailKey: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      index: true,
    },
    modulePrice: {
      type: Number,
      required: true,
      validate: {
        validator: function (value) {
          return value <= this.price
        },
        message: 'Module price cannot be greater than course price',
      },
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    instructors: {
      type: [instructorSchema],
      validate: {
        validator: function (v) {
          return v.length > 0
        },
        message: 'Course must have at least one instructor',
      },
    },
    featured: {
      type: Boolean,
      default: false,
      index: true,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalStudents: {
      type: Number,
      default: 0,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
)

courseSchema.index({ title: 'text', description: 'text' })
courseSchema.index({ category: 1, featured: 1 })
courseSchema.index({ creator: 1, createdAt: -1 })

courseSchema.virtual('modules', {
  ref: 'Module',
  localField: '_id',
  foreignField: 'course',
})

courseSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

courseSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})

const moduleSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: String,
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    order: {
      type: Number,
      required: true,
      index: true,
    },
    prerequisites: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Module',
      },
    ],
    isAccessible: {
      type: Boolean,
      default: true,
    },
    dependencies: [
      {
        module: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Module',
        },
        requiredCompletion: {
          type: Number,
          min: 0,
          max: 100,
          default: 100,
        },
      },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
)

moduleSchema.virtual('lessons', {
  ref: 'Lesson',
  localField: '_id',
  foreignField: 'module',
})

moduleSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

moduleSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})


const lessonSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: String,
    // New field for rich text content
    details: {
      type: String,
      maxLength: 50000, // 50KB limit for rich text content
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      required: true,
      index: true,
    },
    order: {
      type: Number,
      required: true,
      index: true,
    },
    // Video related fields
    videoUrl: String,
    dashUrl: String,
    rawUrl: String,
    cloudflareVideoId: String,
    duration: Number,
    thumbnail: String,
    videoMeta: {
      size: Number,
      created: String,
      modified: String,
      status: String,
    },
    // Downloadable assets/files
    assets: [
      {
        title: {
          type: String,
          required: true,
          trim: true,
        },
        description: String,
        fileUrl: {
          type: String,
          required: true,
        },
        fileKey: {
          type: String,
          required: true,
        },
        fileType: String,
        fileSize: Number,
        downloadCount: {
          type: Number,
          default: 0,
        },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
        isPublic: {
          type: Boolean,
          default: false,
        },
      },
    ],
    //  quiz settings
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    },
    quizSettings: {
      required: {
        type: Boolean,
        default: false,
      },
      minimumPassingScore: {
        type: Number,
        min: 0,
        max: 100,
        default: 70,
      },
      allowReview: {
        type: Boolean,
        default: true,
      },
      // Controls whether to block next lesson until quiz is completed
      blockProgress: {
        type: Boolean,
        default: true,
      },
      // Controls whether to show quiz before/after lesson content
      showQuizAt: {
        type: String,
        enum: ['before', 'after', 'any'],
        default: 'after',
      },
      // Minimum time spent on lesson before attempting quiz
      minimumTimeRequired: {
        type: Number, // in minutes
        min: 0,
        default: 0,
      },
    },
    // Content requirements for completion
    completionRequirements: {
      watchVideo: {
        type: Boolean,
        default: false,
      },
      downloadAssets: [
        {
          assetId: {
            type: mongoose.Schema.Types.ObjectId,
          },
          required: {
            type: Boolean,
            default: false,
          },
        },
      ],
      minimumTimeSpent: {
        type: Number, // in minutes
        default: 0,
      },
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    strictPopulate: false,
  }
)

// Virtual to check if the lesson has a quiz
lessonSchema.virtual('hasQuiz').get(function () {
  return !!this.quiz
})

// Virtual to check if the lesson has required assets
lessonSchema.virtual('hasRequiredAssets').get(function () {
  return this.completionRequirements.downloadAssets.some((asset) => asset.required)
})

// Pre-save middleware to enforce consistent quiz settings
lessonSchema.pre('save', function (next) {
  if (this.isModified('quiz') || this.isModified('quizSettings')) {
    if (!this.quiz) {
      // Reset quiz settings if no quiz is attached
      this.quizSettings = {
        required: false,
        minimumPassingScore: 70,
        allowReview: true,
        blockProgress: true,
        showQuizAt: 'after',
        minimumTimeRequired: 0,
      }
    }
  }
  next()
})

lessonSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

lessonSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})

// Quiz Schema
const quizSchema = new mongoose.Schema(
  {
    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: String,
    instructions: String,
    duration: {
      type: Number, // in minutes
      required: true,
      min: 1
    },
    passingScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    maxAttempts: {
      type: Number,
      required: true,
      default: 3,
      min: 1
    },
    shuffleQuestions: {
      type: Boolean,
      default: false
    },
    shuffleOptions: {
      type: Boolean,
      default: false
    },
    showResults: {
      type: Boolean, // Whether to show correct answers after submission
      default: true
    },
    questions: [{
      questionText: {
        type: String,
        required: true
      },
      type: {
        type: String,
        enum: ['mcq', 'fillInGaps', 'essay'],
        required: true
      },
      marks: {
        type: Number,
        required: true,
        default: 1
      },
      // For MCQ
      options: [{
        text: String,
        isCorrect: Boolean
      }],
      // For fill in gaps
      gapAnswers: [{
        position: Number,
        correctAnswer: String,
        caseSensitive: {
          type: Boolean,
          default: false
        },
        alternativeAnswers: [String] // Accept multiple possible answers
      }],
      // For essay questions
      rubric: {
        criteria: [{
          name: String,
          description: String,
          maxScore: Number
        }],
        totalMarks: Number
      },
      explanation: String // Explanation shown after attempt (if showResults is true)
    }],
    totalMarks: {
      type: Number,
      required: true
    },
    requireManualGrading: {
      type: Boolean,
      default: false
    },
    gradingInProgress: {
      type: Boolean,
      default: false
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
)

// Quiz schema middleware to calculate total marks
quizSchema.pre('save', function(next) {
  if (this.isModified('questions')) {
    this.totalMarks = this.questions.reduce((sum, question) => sum + question.marks, 0)
    this.requireManualGrading = this.questions.some(q => q.type === 'essay')
  }
  next()
})

// Quiz Attempt Schema
const quizAttemptSchema = new mongoose.Schema(
  {
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    submittedAt: {
      type: Date,
      index: true,
    },
    answers: [{
      question: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
      },
      type: {
        type: String,
        enum: ['mcq', 'fillInGaps', 'essay'],
        required: true,
      },
      // For MCQ
      selectedOptions: [{
        type: String
      }],
      // For fill in gaps
      gapAnswers: [{
        position: Number,
        answer: String
      }],
      // For essay
      essayAnswer: {
        text: String,
        attachments: [{
          url: String,
          key: String,
          name: String,
          type: String
        }]
      },
      // Grading
      marks: Number,
      feedback: String,
      rubricScores: [{
        criteriaName: String,
        score: Number,
        feedback: String
      }],
      isCorrect: Boolean,
      autoGraded: Boolean
    }],
    score: Number,
    percentage: Number,
    passed: Boolean,
    attempt: {
      type: Number,
      required: true,
    },
    gradedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    gradingComplete: {
      type: Boolean,
      default: false,
      index: true
    },
    status: {
      type: String,
      enum: ['inProgress', 'submitted', 'grading', 'completed'],
      default: 'inProgress',
      index: true
    },
    timeSpent: Number, // in seconds
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
)

// Index for checking attempt limits
quizAttemptSchema.index({ quiz: 1, user: 1, attempt: 1 }, { unique: true })

// Virtual for remaining time
quizAttemptSchema.virtual('remainingTime').get(function() {
  if (this.status !== 'inProgress' || !this.startedAt) return 0
  
  const quiz = this.quiz
  if (!quiz || !quiz.duration) return 0
  
  const endTime = new Date(this.startedAt.getTime() + quiz.duration * 60000)
  const remaining = endTime - new Date()
  
  return Math.max(0, Math.floor(remaining / 1000))
})

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    purchaseType: {
      type: String,
      enum: ['course', 'module'],
      required: true,
      index: true,
    },
    modules: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Module',
      },
    ],
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'BDT',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    transactionId: {
      type: String,
      unique: true,
      sparse: true,
    },
    customerDetails: {
      name: String,
      email: String,
      address: String,
      city: String,
      country: String,
      phone: String,
    },
    completedAt: Date,
    refundedAt: Date,
    refundReason: String,
    gatewayPageURL: String,
    gatewayData: Object,
    sslcommerzSessionKey: String,
    discount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Discount',
    },
    discountedAmount: Number,
    ipnResponse: Object,
    validationResponse: Object,
  },
  { timestamps: true }
)

paymentSchema.index({ createdAt: -1 })
paymentSchema.index({ user: 1, status: 1 })

const discountSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['percentage', 'fixed'],
      required: true,
    },
    value: {
      type: Number,
      required: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      index: true,
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      index: true,
    },
    startDate: {
      type: Date,
      index: true,
    },
    endDate: {
      type: Date,
      index: true,
    },
    maxUses: Number,
    usedCount: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
)

discountSchema.index({ code: 1, startDate: 1, endDate: 1 })
discountSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

const progressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      required: true,
      index: true,
    },
    completedLessons: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lesson',
      },
    ],
    completedQuizzes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Quiz',
      },
    ],
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    lastAccessed: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
)

progressSchema.index({ user: 1, course: 1, module: 1 }, { unique: true })

const reviewSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    review: String,
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
)

reviewSchema.index({ user: 1, course: 1 }, { unique: true })
reviewSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

// Update course rating when a review is added or modified
reviewSchema.post('save', async function () {
  const Review = this.constructor
  const Course = mongoose.model('Course')

  const stats = await Review.aggregate([
    { $match: { course: this.course, isDeleted: false } },
    {
      $group: {
        _id: '$course',
        avgRating: { $avg: '$rating' },
      },
    },
  ])

  await Course.findByIdAndUpdate(this.course, {
    rating: stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0,
  })
})

// Progress tracking schemas
const lessonProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
      index: true,
    },
    timeSpent: {
      type: Number, // in seconds
      default: 0,
      min: 0
    },
    lastAccessed: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  { 
    timestamps: true 
  }
)

// Index for querying lesson progress
lessonProgressSchema.index({ user: 1, lesson: 1 }, { unique: true })

const videoProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
      index: true,
    },
    watchedTime: {
      type: Number, // in seconds
      default: 0,
      min: 0
    },
    lastPosition: {
      type: Number, // in seconds
      default: 0,
      min: 0
    },
    completed: {
      type: Boolean,
      default: false
    },
    lastAccessed: {
      type: Date,
      default: Date.now
    }
  },
  { 
    timestamps: true 
  }
)

// Index for querying video progress
videoProgressSchema.index({ user: 1, lesson: 1 }, { unique: true })

const assetProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
      index: true,
    },
    asset: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    downloadCount: {
      type: Number,
      default: 0,
      min: 0
    },
    firstDownloaded: {
      type: Date,
      default: Date.now
    },
    lastDownloaded: {
      type: Date,
      default: Date.now
    }
  },
  { 
    timestamps: true 
  }
)

// Index for querying asset downloads
assetProgressSchema.index({ user: 1, lesson: 1, asset: 1 }, { unique: true })

module.exports = {
  User: mongoose.model('User', userSchema),
  Course: mongoose.model('Course', courseSchema),
  Module: mongoose.model('Module', moduleSchema),
  Lesson: mongoose.model('Lesson', lessonSchema),
  Quiz: mongoose.model('Quiz', quizSchema),
  QuizAttempt: mongoose.model('QuizAttempt', quizAttemptSchema),
  Payment: mongoose.model('Payment', paymentSchema),
  Discount: mongoose.model('Discount', discountSchema),
  Progress: mongoose.model('Progress', progressSchema),
  Review: mongoose.model('Review', reviewSchema),
  LessonProgress : mongoose.model('LessonProgress', lessonProgressSchema),
  VideoProgress : mongoose.model('VideoProgress', videoProgressSchema),
  AssetProgress : mongoose.model('AssetProgress', assetProgressSchema)
}