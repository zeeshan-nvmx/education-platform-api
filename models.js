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
    videoUrl: String,
    cloudflareVideoId: String,
    duration: Number,
    requireQuizPass: {
      type: Boolean,
      default: false,
    },
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
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

lessonSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

lessonSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})

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
    type: {
      type: String,
      enum: ['mcq', 'trueFalse', 'written'],
      required: true,
    },
    passingScore: {
      type: Number,
      required: true,
    },
    timeLimit: Number,
    questions: [
      {
        question: {
          type: String,
          required: true,
        },
        options: [String],
        correctAnswer: String,
        points: {
          type: Number,
          default: 1,
        },
      },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
)

quizSchema.pre('find', function () {
  this.where({ isDeleted: false })
})

quizSchema.pre('findOne', function () {
  this.where({ isDeleted: false })
})

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
    answers: [
      {
        question: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
        },
        answer: String,
        isCorrect: Boolean,
        points: Number,
      },
    ],
    score: Number,
    passed: Boolean,
    gradedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
)

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
}

// const mongoose = require('mongoose')
// const bcrypt = require('bcryptjs')

// const userSchema = new mongoose.Schema(
//   {
//     firstName: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     lastName: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     email: {
//       type: String,
//       required: true,
//       unique: true,
//       trim: true,
//       lowercase: true,
//       index: true,
//     },
//     password: {
//       type: String,
//       required: true,
//       minlength: 8,
//       select: false,
//     },
//     role: {
//       type: String,
//       enum: ['user', 'admin', 'subAdmin', 'moderator'],
//       default: 'user',
//       index: true,
//     },
//     isEmailVerified: {
//       type: Boolean,
//       default: false,
//     },
//     verificationToken: String,
//     resetPasswordToken: String,
//     resetPasswordExpires: Date,
//     enrolledCourses: [
//       {
//         course: {
//           type: mongoose.Schema.Types.ObjectId,
//           ref: 'Course',
//           index: true,
//         },
//         enrolledAt: {
//           type: Date,
//           default: Date.now,
//         },
//         completedModules: [
//           {
//             type: mongoose.Schema.Types.ObjectId,
//             ref: 'Module',
//           },
//         ],
//       },
//     ],
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   {
//     timestamps: true,
//     toJSON: { virtuals: true },
//     toObject: { virtuals: true },
//   }
// )

// userSchema.pre('save', async function (next) {
//   if (!this.isModified('password')) return next()
//   this.password = await bcrypt.hash(this.password, 12)
//   next()
// })

// userSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// userSchema.pre('findOne', function () {
//   this.where({ isDeleted: false })
// })

// const instructorSchema = new mongoose.Schema(
//   {
//     name: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     description: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     designation: {
//       type: String,
//       trim: true,
//     },
//     expertise: [
//       {
//         type: String,
//         trim: true,
//       },
//     ],
//     image: {
//       type: String,
//       trim: true,
//     },
//     imageKey: {
//       type: String,
//       trim: true,
//     },
//     socialLinks: {
//       linkedin: String,
//       twitter: String,
//       website: String,
//     },
//     bio: {
//       type: String,
//       trim: true,
//     },
//     achievements: [
//       {
//         type: String,
//       },
//     ],
//   },
//   { _id: true }
// )

// const courseSchema = new mongoose.Schema(
//   {
//     title: {
//       type: String,
//       required: true,
//       trim: true,
//       index: true,
//     },
//     description: {
//       type: String,
//       required: true,
//     },
//     category: {
//       type: String,
//       required: true,
//       index: true,
//     },
//     thumbnail: {
//       type: String,
//       trim: true,
//     },
//     thumbnailKey: {
//       type: String,
//       trim: true,
//     },
//     price: {
//       type: Number,
//       required: true,
//       index: true,
//     },
//     creator: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//       index: true,
//     },
//     instructors: {
//       type: [instructorSchema],
//       validate: {
//         validator: function (v) {
//           return v.length > 0 // Ensures at least one instructor
//         },
//         message: 'Course must have at least one instructor',
//       },
//     },
//     featured: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//     rating: {
//       type: Number,
//       default: 0,
//       min: 0,
//       max: 5,
//     },
//     totalStudents: {
//       type: Number,
//       default: 0,
//     },
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   {
//     timestamps: true,
//     toJSON: { virtuals: true },
//     toObject: { virtuals: true },
//   }
// )

// courseSchema.index({ title: 'text', description: 'text' })
// courseSchema.index({ category: 1, featured: 1 })
// courseSchema.index({ creator: 1, createdAt: -1 })

// courseSchema.virtual('modules', {
//   ref: 'Module',
//   localField: '_id',
//   foreignField: 'course',
// })

// courseSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// courseSchema.pre('findOne', function () {
//   this.where({ isDeleted: false })
// })

// const moduleSchema = new mongoose.Schema(
//   {
//     title: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     description: String,
//     course: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Course',
//       required: true,
//       index: true,
//     },
//     order: {
//       type: Number,
//       required: true,
//       index: true,
//     },
//     price: {
//       type: Number,
//       required: true,
//     },
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   {
//     timestamps: true,
//     toJSON: { virtuals: true },
//     toObject: { virtuals: true },
//   }
// )

// moduleSchema.virtual('lessons', {
//   ref: 'Lesson',
//   localField: '_id',
//   foreignField: 'module',
// })

// moduleSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// moduleSchema.pre('findOne', function () {
//   this.where({ isDeleted: false })
// })

// const lessonSchema = new mongoose.Schema(
//   {
//     title: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     description: String,
//     module: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Module',
//       required: true,
//       index: true,
//     },
//     order: {
//       type: Number,
//       required: true,
//       index: true,
//     },
//     videoUrl: String,
//     cloudflareVideoId: String,
//     duration: Number,
//     requireQuizPass: {
//       type: Boolean,
//       default: false,
//     },
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// lessonSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// lessonSchema.pre('findOne', function () {
//   this.where({ isDeleted: false })
// })

// const quizSchema = new mongoose.Schema(
//   {
//     lesson: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Lesson',
//       required: true,
//       index: true,
//     },
//     title: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     type: {
//       type: String,
//       enum: ['mcq', 'trueFalse', 'written'],
//       required: true,
//     },
//     passingScore: {
//       type: Number,
//       required: true,
//     },
//     timeLimit: Number,
//     questions: [
//       {
//         question: {
//           type: String,
//           required: true,
//         },
//         options: [String],
//         correctAnswer: String,
//         points: {
//           type: Number,
//           default: 1,
//         },
//       },
//     ],
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// quizSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// quizSchema.pre('findOne', function () {
//   this.where({ isDeleted: false })
// })

// const quizAttemptSchema = new mongoose.Schema(
//   {
//     quiz: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Quiz',
//       required: true,
//       index: true,
//     },
//     user: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//       index: true,
//     },
//     answers: [
//       {
//         question: {
//           type: mongoose.Schema.Types.ObjectId,
//           required: true,
//         },
//         answer: String,
//         isCorrect: Boolean,
//         points: Number,
//       },
//     ],
//     score: Number,
//     passed: Boolean,
//     gradedBy: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//     },
//     submittedAt: {
//       type: Date,
//       default: Date.now,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// const paymentSchema = new mongoose.Schema(
//   {
//     user: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//       index: true,
//     },
//     course: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Course',
//       index: true,
//     },
//     module: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Module',
//       index: true,
//     },
//     amount: {
//       type: Number,
//       required: true,
//     },
//     currency: {
//       type: String,
//       default: 'BDT',
//     },
//     status: {
//       type: String,
//       enum: ['pending', 'completed', 'failed', 'refunded'],
//       default: 'pending',
//       index: true,
//     },
//     transactionId: {
//       type: String,
//       unique: true,
//       sparse: true,
//     },
//     sslcommerzSessionKey: String,
//     discount: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Discount',
//     },
//     discountedAmount: Number,
//   },
//   { timestamps: true }
// )

// paymentSchema.index({ createdAt: -1 })
// paymentSchema.index({ user: 1, status: 1 })

// const discountSchema = new mongoose.Schema(
//   {
//     code: {
//       type: String,
//       required: true,
//       unique: true,
//       uppercase: true,
//       trim: true,
//     },
//     type: {
//       type: String,
//       enum: ['percentage', 'fixed'],
//       required: true,
//     },
//     value: {
//       type: Number,
//       required: true,
//     },
//     course: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Course',
//       index: true,
//     },
//     module: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Module',
//       index: true,
//     },
//     startDate: {
//       type: Date,
//       index: true,
//     },
//     endDate: {
//       type: Date,
//       index: true,
//     },
//     maxUses: Number,
//     usedCount: {
//       type: Number,
//       default: 0,
//     },
//     createdBy: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//     },
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// discountSchema.index({ code: 1, startDate: 1, endDate: 1 })
// discountSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// const progressSchema = new mongoose.Schema(
//   {
//     user: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//       index: true,
//     },
//     course: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Course',
//       required: true,
//       index: true,
//     },
//     completedLessons: [
//       {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'Lesson',
//       },
//     ],
//     completedQuizzes: [
//       {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'Quiz',
//       },
//     ],
//     lastAccessed: {
//       type: Date,
//       default: Date.now,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// progressSchema.index({ user: 1, course: 1 }, { unique: true })

// const reviewSchema = new mongoose.Schema(
//   {
//     user: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'User',
//       required: true,
//       index: true,
//     },
//     course: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Course',
//       required: true,
//       index: true,
//     },
//     rating: {
//       type: Number,
//       required: true,
//       min: 1,
//       max: 5,
//     },
//     review: String,
//     isDeleted: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },
//   },
//   { timestamps: true }
// )

// reviewSchema.index({ user: 1, course: 1 }, { unique: true })
// reviewSchema.pre('find', function () {
//   this.where({ isDeleted: false })
// })

// // Update course rating when a review is added or modified
// reviewSchema.post('save', async function () {
//   const Review = this.constructor
//   const Course = mongoose.model('Course')

//   const stats = await Review.aggregate([
//     { $match: { course: this.course, isDeleted: false } },
//     {
//       $group: {
//         _id: '$course',
//         avgRating: { $avg: '$rating' },
//       },
//     },
//   ])

//   await Course.findByIdAndUpdate(this.course, {
//     rating: stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0,
//   })
// })

// module.exports = {
//   User: mongoose.model('User', userSchema),
//   Course: mongoose.model('Course', courseSchema),
//   Module: mongoose.model('Module', moduleSchema),
//   Lesson: mongoose.model('Lesson', lessonSchema),
//   Quiz: mongoose.model('Quiz', quizSchema),
//   QuizAttempt: mongoose.model('QuizAttempt', quizAttemptSchema),
//   Payment: mongoose.model('Payment', paymentSchema),
//   Discount: mongoose.model('Discount', discountSchema),
//   Progress: mongoose.model('Progress', progressSchema),
//   Review: mongoose.model('Review', reviewSchema),
// }
