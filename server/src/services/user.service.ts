import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { UserType } from '@prisma/client';

/**
 * User Service — profile management and admin user listing.
 */

// Reusable select object to avoid exposing passwords
const userSelect = {
  id: true,
  email: true,
  name: true,
  type: true,
  phone: true,
  profilePhotoUrl: true,
  hasStudentPass: true,
  studentPassActivatedAt: true,
  preferredLanguage: true,
  createdAt: true,
  updatedAt: true,
  shop: {
    select: {
      id: true,
      name: true,
      isOpen: true,
      isApproved: true,
      isArchived: true,
    },
  },
} as const;

/**
 * Get user profile by ID.
 */
export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: userSelect,
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  return user;
}

/**
 * Update the current user's profile.
 */
export async function updateUserProfile(
  userId: string,
  data: {
    name?: string;
    phone?: string;
    preferredLanguage?: string;
    profilePhotoUrl?: string;
  }
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.preferredLanguage !== undefined && { preferredLanguage: data.preferredLanguage }),
      ...(data.profilePhotoUrl !== undefined && { profilePhotoUrl: data.profilePhotoUrl }),
    },
    select: userSelect,
  });

  return user;
}

/**
 * Admin: list all users with pagination and optional type filter.
 */
export async function listUsers(options: {
  page?: number;
  limit?: number;
  type?: UserType;
  search?: string;
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (options.type) {
    where.type = options.type;
  }

  if (options.search) {
    where.OR = [
      { name: { contains: options.search, mode: 'insensitive' } },
      { email: { contains: options.search, mode: 'insensitive' } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: userSelect,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}
