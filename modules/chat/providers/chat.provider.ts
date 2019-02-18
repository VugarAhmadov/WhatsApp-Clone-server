import { Injectable } from '@graphql-modules/di'
import { PubSub } from 'apollo-server-express'
import { Connection } from 'typeorm'
import { User } from '../models/User';
import { Chat } from '../models/Chat';
import { UserProvider } from '../../user/providers/user.provider';

@Injectable()
export class ChatProvider {
  constructor(
    private pubsub: PubSub,
    private connection: Connection,
    private userProvider: UserProvider,
  ) {
  }

  repository = this.connection.getRepository(Chat);
  currentUser = this.userProvider.currentUser as User;

  createQueryBuilder() {
    return this.connection.createQueryBuilder(Chat, 'chat');
  }

  async getChats() {
    return this
      .createQueryBuilder()
      .leftJoin('chat.listingMembers', 'listingMembers')
      .where('listingMembers.id = :id', { id: this.currentUser.id })
      .orderBy('chat.createdAt', 'DESC')
      .getMany();
  }

  async getChat(chatId: string) {
    const chat = await this
      .createQueryBuilder()
      .whereInIds(chatId)
      .getOne();

    return chat || null;
  }

  async addChat(userId: string) {
    const user = await this.userProvider
      .createQueryBuilder()
      .whereInIds(userId)
      .getOne() as User;

    if (!user) {
      throw new Error(`User ${userId} doesn't exist.`);
    }

    let chat = await this
      .createQueryBuilder()
      .where('chat.name IS NULL')
      .innerJoin('chat.allTimeMembers', 'allTimeMembers1', 'allTimeMembers1.id = :currentUserId', {
        currentUserId: this.currentUser.id,
      })
      .innerJoin('chat.allTimeMembers', 'allTimeMembers2', 'allTimeMembers2.id = :userId', {
        userId: userId,
      })
      .innerJoinAndSelect('chat.listingMembers', 'listingMembers')
      .getOne();

    if (chat) {
      // Chat already exists. Both users are already in the userIds array
      const listingMembers = await this.userProvider
        .createQueryBuilder()
        .innerJoin(
          'user.listingMemberChats',
          'listingMemberChats',
          'listingMemberChats.id = :chatId',
          { chatId: chat.id },
        )
        .getMany();

      if (!listingMembers.find(user => user.id === this.currentUser.id)) {
        // The chat isn't listed for the current user. Add him to the memberIds
        chat.listingMembers = Promise.resolve([
          ...await chat.listingMembers,
          this.currentUser
        ]);
        chat = await this.repository.save(chat);

        return chat || null;
      } else {
        return chat;
      }
    } else {
      // Create the chat
      chat = await this.repository.save(
        new Chat({
          allTimeMembers: [this.currentUser, user],
          // Chat will not be listed to the other user until the first message gets written
          listingMembers: [this.currentUser],
        }),
      );

      return chat || null;
    }
  }

  async addGroup(
    userIds: string[],
    {
      groupName,
      groupPicture,
    }: {
      groupName?: string
      groupPicture?: string
    } = {},
  ) {
    let users: User[] = [];
    for (let userId of userIds) {
      const user = await this.userProvider
        .createQueryBuilder()
        .whereInIds(userId)
        .getOne() as User;

      if (!user) {
        throw new Error(`User ${userId} doesn't exist.`);
      }

      users.push(user);
    }

    const chat = await this.repository.save(
      new Chat({
        name: groupName,
        admins: [this.currentUser ],
        picture: groupPicture || undefined,
        owner: this.currentUser,
        allTimeMembers: [...users, this.currentUser],
        listingMembers: [...users, this.currentUser],
        actualGroupMembers: [...users, this.currentUser],
      }),
    );

    this.pubsub.publish('chatAdded', {
      creatorId: this.currentUser.id,
      chatAdded: chat,
    });

    return chat || null;
  }

  async updateChat(
    chatId: string,
    {
      name,
      picture,
    }: {
      name?: string
      picture?: string
    } = {},
  ) {
    const chat = await this.createQueryBuilder()
      .whereInIds(chatId)
      .getOne();

    if (!chat) return null;
    if (!chat.name) return chat;

    name = name || chat.name;
    picture = picture || chat.picture;
    Object.assign(chat, { name, picture });

    // Update the chat
    await this.repository.save(chat);

    this.pubsub.publish('chatUpdated', {
      updaterId: this.currentUser.id,
      chatUpdated: chat,
    });

    return chat || null;
  }

  async removeChat(chatId: string) {
    const chat = await this.createQueryBuilder()
      .whereInIds(Number(chatId))
      .innerJoinAndSelect('chat.listingMembers', 'listingMembers')
      .leftJoinAndSelect('chat.actualGroupMembers', 'actualGroupMembers')
      .leftJoinAndSelect('chat.admins', 'admins')
      .leftJoinAndSelect('chat.owner', 'owner')
      .getOne();

    if (!chat) {
      throw new Error(`The chat ${chatId} doesn't exist.`)
    }

    if (!chat.name) {
      let listingMembers = await chat.listingMembers;

      // Chat
      if (!listingMembers.find(user => user.id === this.currentUser.id)) {
        throw new Error(`The user is not a listing member of the chat ${chatId}.`)
      }

      // Remove the current user from who gets the chat listed. The chat will no longer appear in his list
      chat.listingMembers = Promise.resolve(listingMembers.filter(user => user.id !== this.currentUser.id));

      listingMembers = await chat.listingMembers;

      // Check how many members are left
      if (listingMembers.length === 0) {
        // Delete the chat
        await this.repository.remove(chat);
      } else {
        // Update the chat
        await this.repository.save(chat);
      }

      return chatId;
    } else {
      // Group

      let listingMembers = await chat.listingMembers;

      // Remove the current user from who gets the group listed. The group will no longer appear in his list
      chat.listingMembers = Promise.resolve(listingMembers.filter(user => user.id !== this.currentUser.id));

      listingMembers = await chat.listingMembers;

      // Check how many members (including previous ones who can still access old messages) are left
      if (listingMembers.length === 0) {
        // Remove the group
        await this.repository.remove(chat);
      } else {
        // Update the group

        const actualGroupMembers = await chat.actualGroupMembers;
        // Remove the current user from the chat members. He is no longer a member of the group
        chat.actualGroupMembers = actualGroupMembers && Promise.resolve(actualGroupMembers.filter(user =>
          user.id !== this.currentUser.id
        ));
        
        let admins = await chat.admins;

        // Remove the current user from the chat admins
        chat.admins = admins && Promise.resolve((await admins).filter(user => user.id !== this.currentUser.id));
        
        admins = await chat.admins;
        
        // If there are no more admins left the group goes read only
        // A null owner means the group is read-only
        chat.owner = admins && Promise.resolve(admins[0] || null);

        await this.repository.save(chat);
      }

      return chatId;
    }
  }

  async filterChatAddedOrUpdated(chatAddedOrUpdated: Chat, creatorOrUpdaterId: number) {

    return creatorOrUpdaterId.toString() !== this.currentUser.id &&
      (await chatAddedOrUpdated.listingMembers).some((user: User) => user.id === this.currentUser.id);
  }

  async updateUser({
    name,
    picture,
  }: {
    name?: string,
    picture?: string,
  } = {}) {
    await this.userProvider.updateUser({ name, picture });


    const data = await this.connection
      .createQueryBuilder(User, 'user')
      .where('user.id = :id', { id: this.currentUser.id })
      // Get a list of the chats who have/had currentUser involved
      .innerJoinAndSelect(
        'user.allTimeMemberChats',
        'allTimeMemberChats',
        // Groups are unaffected
        'allTimeMemberChats.name IS NULL',
      )
      // We need to notify only those who get the chat listed (except currentUser of course)
      .innerJoin(
        'allTimeMemberChats.listingMembers',
        'listingMembers',
        'listingMembers.id != :currentUserId',
        {
          currentUserId: this.currentUser.id,
        })
      .getOne();

    const chatsAffected = data && data.allTimeMemberChats || [];

    chatsAffected.forEach(chat => {
      this.pubsub.publish('chatUpdated', {
        updaterId: this.currentUser.id,
        chatUpdated: chat,
      })
    });

    return this.currentUser;
  }
}
