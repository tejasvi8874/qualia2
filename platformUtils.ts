import Constants from "expo-constants";

export const isWeb = (): boolean => {
    return !Constants.platform?.ios && !Constants.platform?.android;
};
