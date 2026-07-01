export interface Behavior {
  id: string;
  name: string;
  description: string;
  execute: () => Promise<string> | string;
}

export const behaviors: Record<string, any> = {
  beh_north_1_mr252dzm: null, // Redundant; completely subsumed by the more robust and comprehensive 'beh_self_description_2'
  beh_self_description_2: {
    id: 'beh_self_description_2',
    name: 'Self Description',
    description: 'A robust and comprehensive self-description behavior for the autonomous agent.',
    execute: async () => {
      return "I am an autonomous agent capable of self-description and executing registered behaviors.";
    }
  }
};

export const identity = {
  name: "AI-Agent",
  behaviors: behaviors
};
