export type User = {
  id: string;
  email: string;
};

export type Env = {
  Variables: {
    user: User;
  };
};
